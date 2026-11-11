import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_DATASET } from '../db/defaultDataset'
import { DEFAULT_LIMITS } from '../db/wire'
import { DbClient, DbFailure } from '../db/dbClient'
import type { DbInfo, SchemaNamespace, TxStatus, WorkerFailure } from '../db/protocol'
import { dbNameFor, dbNameFromIdb } from '../db/storageNames'
import { offsetToLineCol, pgPositionToOffset } from '../db/sqlLexer'
import type { ThemeChoice, Workspace } from '../workspace/types'
import {
  createWorkspace,
  findOrphans,
  HEARTBEAT_INTERVAL_MS,
  loadWorkspace,
  pruneHeartbeats,
  readHeartbeats,
  removeHeartbeat,
  safeStorage,
  WorkspaceSaver,
  writeHeartbeat,
  type SaveState,
} from '../workspace/sessionStore'
import { acquireSessionLock } from '../workspace/sessionLock'
import { randomId } from '../workspace/ids'
import { bundledBase, clearBase, importedBase, loadBase, saveBase, type BaseDataset } from '../workspace/baseDataset'
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor'
import { SchemaTree } from '../components/SchemaTree'
import { ResultsPanel } from '../components/ResultsPanel'
import { Splitter } from '../components/Splitter'
import { ConfirmDialog, ImportDatabaseDialog, type ConfirmRequest } from '../components/Dialogs'
import { Icon, ThemeIcon } from '../components/Icon'
import type { ErrorLocation, RunRecord } from './runTypes'
import { txText } from './describe'

type Phase = 'booting' | 'starting' | 'ready' | 'running' | 'restarting' | 'resetting' | 'failed'


const BUNDLED = bundledBase(DEFAULT_DATASET)
const THEME_KEY = 'krash:theme'
const DISCARDED = 'PostgreSQL was restarted from the last saved state; this run and any open transaction were discarded.'

function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

function errorLocationFor(sql: string, baseOffset: number, docText: string, position: string | undefined): ErrorLocation | null {
  const p = Number(position)
  if (!position || !Number.isFinite(p) || p < 1) return null
  const offset = baseOffset + pgPositionToOffset(sql, p)
  const { line, col } = offsetToLineCol(docText, offset)
  const lineText = docText.split('\n')[line - 1] ?? ''
  return { offset, line, col, text: lineText.trim().slice(0, 80) }
}

export function App() {
  const [ws, setWs] = useState<Workspace | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const [phase, setPhase] = useState<Phase>('booting')
  const [failure, setFailure] = useState<WorkerFailure | null>(null)
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [schema, setSchema] = useState<SchemaNamespace[] | null>(null)
  const [schemaStale, setSchemaStale] = useState(false)
  const [txStatus, setTxStatus] = useState<TxStatus>('I')
  const [lastRun, setLastRun] = useState<RunRecord | null>(null)
  const [slowStart, setSlowStart] = useState(false)
  const [importError, setImportError] = useState('')
  const [announce, setAnnounce] = useState('')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  const [base, setBase] = useState<BaseDataset>(BUNDLED)
  const [sessionMissing, setSessionMissing] = useState(false)

  const client = useRef<DbClient | null>(null)
  const saver = useRef<WorkspaceSaver | null>(null)
  const wsRef = useRef<Workspace | null>(null)
  const editor = useRef<SqlEditorHandle>(null)
  const mainCol = useRef<HTMLDivElement>(null)
  const runCounter = useRef(0)
  const activeRun = useRef<number | null>(null)
  const local = useRef<Storage | null>(null)
  const session = useRef<Storage | null>(null)
  const baseRef = useRef<BaseDataset>(BUNDLED)

  wsRef.current = ws
  baseRef.current = base


  /** Update the workspace and schedule a save. */
  const updateWs = useCallback((fn: (w: Workspace) => Workspace) => {
    setWs((prev) => {
      if (!prev) return prev
      const next = fn(prev)
      if (next !== prev) saver.current?.schedule(next)
      return next
    })
  }, [])

  // ---- Theme -------------------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* preference only */
    }
  }, [theme])

  // ---- Database lifecycle ---------------------------------------------------------
  const refreshSchema = useCallback(async () => {
    const c = client.current
    if (!c) return
    setSchemaStale(true)
    try {
      setSchema(await c.request({ type: 'getSchema' }))
    } catch {
      /* e.g. inside an aborted transaction: keep the previous tree */
    } finally {
      setSchemaStale(false)
    }
  }, [])

  const handleInfo = useCallback((i: DbInfo) => {
    setInfo(i)
    setFailure(null)
    setTxStatus('I')
  }, [])

  const openDb = useCallback(
    async (dbName: string | null, context: 'boot' | 'restart') => {
      const c = client.current!
      setPhase(context === 'boot' ? 'starting' : 'restarting')
      try {
        const i = await c.request({ type: 'init', dbName, dataset: baseRef.current })
        handleInfo(i)
        setPhase('ready')
        await refreshSchema()
        return true
      } catch (err) {
        const f: WorkerFailure =
          err instanceof DbFailure ? err.failure : { kind: 'internal', message: 'The database could not be started.', detail: String(err) }
        setFailure(f)
        setPhase('failed')
        setAnnounce(`Database failed: ${f.message}`)
        return false
      }
    },
    [handleInfo, refreshSchema],
  )

  /** After Stop or a crash: reopen the same database from its last saved state. */
  const restartAfterLoss = useCallback(async () => {
    const w = wsRef.current
    if (w) await openDb(w.dbName, 'restart')
  }, [openDb])

  // ---- Boot ----------------------------------------------------------------------
  useEffect(() => {
    let disposed = false
    const store = safeStorage('session')
    session.current = store
    local.current = safeStorage('local')
    const idbAvailable = typeof indexedDB !== 'undefined'
    const persistentPossible = !!store && idbAvailable
    const startBase = loadBase(store, BUNDLED)
    baseRef.current = startBase
    setBase(startBase)
    setSessionMissing(!store)

    saver.current = new WorkspaceSaver(store, (s, e) => {
      setSaveState(s)
      setSaveError(e ?? '')
    })
    const c = new DbClient()
    client.current = c
    c.onCrash = () => {
      const id = activeRun.current
      setLastRun((r) =>
        r && r.id === id ? { ...r, status: 'done', failure: { kind: 'crash', message: `PostgreSQL stopped unexpectedly while running this SQL. ${DISCARDED}` } } : r,
      )
      activeRun.current = null
      void restartAfterLoss()
    }

    ;(async () => {
      let w = loadWorkspace(store)
      if (!w) w = createWorkspace(persistentPossible)
      if (w.dbName && !idbAvailable) w = { ...w, dbName: null }

      // A duplicated tab carries a copy of this session: give it its own database.
      if (w.dbName) {
        const lock = await acquireSessionLock(w.sessionId)
        if (lock === 'held-elsewhere') {
          const sessionId = randomId(16)
          w = { ...w, sessionId, generation: 1, dbName: dbNameFor(sessionId, 1) }
          await acquireSessionLock(sessionId, 100)
        }
      }
      if (disposed) return
      writeHeartbeat(local.current, w.sessionId)
      setWs(w)
      saver.current!.schedule(w)
      saver.current!.flush()
      await openDb(w.dbName, 'boot')
      if (w.dbName) void cleanupOrphans(w)
    })()

    const beat = setInterval(() => {
      const cur = wsRef.current
      if (cur) writeHeartbeat(local.current, cur.sessionId)
    }, HEARTBEAT_INTERVAL_MS)
    const onHide = () => saver.current?.flush()
    window.addEventListener('pagehide', onHide)
    return () => {
      disposed = true
      clearInterval(beat)
      window.removeEventListener('pagehide', onHide)
      c.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Starting can be slow on old machines; say so in the status instead of looking stuck.
  useEffect(() => {
    setSlowStart(false)
    if (phase !== 'starting' && phase !== 'restarting') return
    const t = setTimeout(() => setSlowStart(true), 30_000)
    return () => clearTimeout(t)
  }, [phase])

  // The query lives only in this browser tab: warn before closing it while there is SQL in it.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      saver.current?.flush()
      if (wsRef.current?.sql.trim()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  async function cleanupOrphans(w: Workspace) {
    try {
      pruneHeartbeats(local.current)
      const list = (await indexedDB.databases?.()) ?? []
      const names = list.map((d) => (d.name ? dbNameFromIdb(d.name) : null)).filter((n): n is string => !!n)
      const orphans = findOrphans(names, w, readHeartbeats(local.current))
      for (const name of orphans) await client.current?.request({ type: 'dropDatabase', dbName: name }).catch(() => {})
    } catch {
      /* best effort */
    }
  }

  // ---- Query text ---------------------------------------------------------------------
  const onEdit = useCallback((text: string) => updateWs((w) => (w.sql === text ? w : { ...w, sql: text })), [updateWs])

  // ---- Running SQL -------------------------------------------------------------------
  const run = useCallback(async () => {
    const c = client.current
    const w = wsRef.current
    if (!c || !w || phase !== 'ready' || !editor.current) return
    const target = editor.current.getRunTarget()
    const id = ++runCounter.current
    activeRun.current = id
    const fromLine = offsetToLineCol(target.docText, target.offset).line
    const toLine = offsetToLineCol(target.docText, target.offset + target.sql.length).line
    const record: RunRecord = {
      id,
      isSelection: target.isSelection,
      lines: { from: fromLine, to: toLine },
      startedAt: Date.now(),
      status: 'running',
      outcome: null,
      failure: null,
      errorLocation: null,
    }
    setLastRun(record)
    setPhase('running')
    setAnnounce('Running…')
    try {
      const outcome = await c.request({ type: 'execute', sql: target.sql, maxRows: DEFAULT_LIMITS.maxRows })
      if (activeRun.current !== id) return
      const errorLocation = outcome.error ? errorLocationFor(target.sql, target.offset, target.docText, outcome.error.position) : null
      setLastRun({ ...record, status: 'done', outcome, errorLocation })
      setTxStatus(outcome.txStatus)
      setPhase('ready')
      setAnnounce(
        outcome.error
          ? `Error: ${outcome.error.message}${errorLocation ? ` at line ${errorLocation.line}` : ''}`
          : `Done: ${outcome.statementCount} statement${outcome.statementCount === 1 ? '' : 's'} in ${outcome.durationMs} ms.`,
      )
      if (outcome.txStatus !== 'E') void refreshSchema()
    } catch (err) {
      if (activeRun.current !== id) return
      let f: WorkerFailure = err instanceof DbFailure ? err.failure : { kind: 'internal', message: String(err) }
      if (f.kind === 'cancelled') f = { kind: 'cancelled', message: `Stopped. ${DISCARDED}` }
      setLastRun({ ...record, status: 'done', failure: f })
      if (f.kind !== 'crash' && f.kind !== 'cancelled') setPhase('ready')
      setAnnounce(`Problem: ${f.message}`)
    } finally {
      if (activeRun.current === id) activeRun.current = null
    }
  }, [phase, refreshSchema])

  const stop = () => {
    const c = client.current
    if (!c || phase !== 'running') return
    c.stop()
    void restartAfterLoss()
  }

  // Ctrl/Cmd+Enter outside the editor (e.g. on a tab or in results).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.defaultPrevented) return
      if ((e.target as HTMLElement | null)?.closest('dialog, input, textarea')) return
      e.preventDefault()
      void run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run])

  // ---- Reset / import / clear ----------------------------------------------------------
  /**
   * Build a fresh database from `next` in a new generation and swap to it only
   * when it loaded completely; otherwise the previous database stays in use.
   */
  /** Returns an error message, or null on success. */
  const rebuildDb = async (next: BaseDataset, mode: 'reset' | 'import'): Promise<string | null> => {
    const c = client.current
    const w = wsRef.current
    if (!c || !w) return 'The database is not available.'
    setPhase('resetting')
    setAnnounce(mode === 'reset' ? 'Resetting the database…' : 'Importing the database…')
    const generation = w.generation + 1
    const newName = w.dbName ? dbNameFor(w.sessionId, generation) : null
    const oldName = w.dbName
    try {
      const i = await c.request({ type: 'createFresh', dbName: newName, dataset: next })
      const nextWs = { ...w, dbName: newName, generation }
      setWs(nextWs)
      saver.current?.schedule(nextWs)
      saver.current?.flush()
      baseRef.current = next
      setBase(next)
      saveBase(session.current, next)
      handleInfo(i)
      setPhase('ready')
      setLastRun(null)
      setAnnounce(mode === 'reset' ? 'The database was reset.' : 'The database was imported.')
      await refreshSchema()
      if (oldName) await c.request({ type: 'dropDatabase', dbName: oldName }).catch(() => {})
      return null
    } catch (err) {
      const f = err instanceof DbFailure ? err.failure : { kind: 'internal' as const, message: String(err) }
      const message = `${f.message.replace(/\.?\s*$/, '.')} Your previous database is still in use.`
      if (f.kind === 'crash') return message // the crash handler restarts the previous database
      setPhase(info ? 'ready' : 'failed')
      setAnnounce(`${mode === 'reset' ? 'Reset' : 'Import'} failed.`)
      if (mode === 'reset') {
        setLastRun({
          id: ++runCounter.current,
          isSelection: false,
          lines: { from: 1, to: 1 },
          startedAt: Date.now(),
          status: 'done',
          outcome: null,
          failure: { kind: f.kind, message: `Reset failed: ${message}` },
          errorLocation: null,
        })
      }
      return message
    }
  }

  const askResetDb = () =>
    setConfirm({
      title: 'Reset database?',
      body: (
        <p>
          This removes every change you made to the database (tables, rows, views…) and restores “{base.name}”. Your query is kept.
        </p>
      ),
      confirmLabel: 'Reset database',
      danger: true,
      onConfirm: () => void rebuildDb(baseRef.current, 'reset'),
    })

  const importDb = async (sql: string) => {
    setImportError('')
    const error = await rebuildDb(importedBase(sql), 'import')
    if (error) setImportError(error)
    else setImportOpen(false)
  }

  const askClearWorkspace = () =>
    setConfirm({
      title: 'Clear this workspace?',
      body: (
        <>
          <p>This deletes your query and this tab’s database from the browser, then starts an empty workspace with the default database.</p>
          <p>This cannot be undone.</p>
        </>
      ),
      confirmLabel: 'Clear workspace',
      danger: true,
      onConfirm: async () => {
        const c = client.current
        const w = wsRef.current
        if (!c || !w) return
        setPhase('resetting')
        try {
          await c.request({ type: 'close' })
          if (w.dbName) await c.request({ type: 'dropDatabase', dbName: w.dbName })
        } catch {
          /* fall through: a stale database is removed by orphan cleanup later */
        }
        saver.current?.clear()
        clearBase(session.current)
        removeHeartbeat(local.current, w.sessionId)
        window.location.reload()
      },
    })

  // ---- Render ---------------------------------------------------------------------------
  const goToError = (offset: number) => editor.current?.moveTo(offset)
  const ui = ws?.ui
  const collapsed = !!ui?.sidebarCollapsed

  const status = (() => {
    switch (phase) {
      case 'booting':
      case 'starting':
        return { state: 'loading', text: slowStart ? 'Still starting PostgreSQL…' : 'Starting PostgreSQL…' }
      case 'running':
        return { state: 'running', text: 'Running…' }
      case 'restarting':
        return { state: 'running', text: slowStart ? 'Still restarting PostgreSQL…' : 'Restarting PostgreSQL…' }
      case 'resetting':
        return { state: 'running', text: 'Resetting database…' }
      case 'failed':
        return { state: 'failed', text: 'Database unavailable' }
      case 'ready':
        if (txStatus === 'T') return { state: 'tx', text: 'Ready · transaction open' }
        if (txStatus === 'E') return { state: 'failed', text: 'Transaction failed · ROLLBACK' }
        return { state: 'ready', text: 'Ready' }
    }
  })()

  const saveText =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved in this tab'
        : saveState === 'failed'
          ? 'Save failed'
          : 'Not saved'

  const cycleTheme = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))
  const themeLabel = { system: 'System appearance', light: 'Light appearance', dark: 'Dark appearance' }[theme]
  const nextThemeLabel = { system: 'light', light: 'dark', dark: 'system' }[theme]

  const failurePanel =
    phase === 'failed' && failure ? (
      <FailurePanel
            failure={failure}
            persistent={!!ws?.dbName}
            onRetry={() => void openDb(wsRef.current?.dbName ?? null, 'boot')}
            onNewDb={async () => {
              const w = wsRef.current
              if (!w) return
              const generation = w.generation + 1
              const next = { ...w, generation, dbName: w.dbName ? dbNameFor(w.sessionId, generation) : null }
              setWs(next)
              saver.current?.schedule(next)
              saver.current?.flush()
              const old = w.dbName
              if (await openDb(next.dbName, 'boot')) {
                if (old) await client.current?.request({ type: 'dropDatabase', dbName: old }).catch(() => {})
              }
            }}
            onMemory={async () => {
              const w = wsRef.current
              if (!w) return
              const next = { ...w, dbName: null }
              setWs(next)
              saver.current?.schedule(next)
              await openDb(null, 'boot')
            }}
          />
    ) : null

  return (
    <>
      <a className="skip-link" href="#editor-panel">
        Skip to editor
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            k.
          </span>
          <div>
            <h1>Krash</h1>
            <p>A little room for PostgreSQL.</p>
          </div>
        </div>
        <button
          type="button"
          className="theme-control"
          onClick={cycleTheme}
          aria-label={`${themeLabel}. Switch to ${nextThemeLabel} appearance`}
          title={`${themeLabel}. Switch to ${nextThemeLabel} appearance`}
        >
          <ThemeIcon choice={theme} />
        </button>
      </header>

      <main>
        <div className="workspace-heading">
          <p className="eyebrow">
            POSTGRESQL WORKSPACE
          </p>
          <p className={`save-state save-${saveState}`} role="status" title={saveError || undefined}>
            {saveText}
          </p>
        </div>

        <div className={`workspace${collapsed ? ' sidebar-collapsed' : ''}`}>
          <aside className="panel db-panel" aria-labelledby="db-title">
              <div className="panel-header">
                <h2 id="db-title">Database</h2>
                {!collapsed && (
                  <div className="db-actions" role="group" aria-label="Database">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={askResetDb}
                      disabled={phase !== 'ready'}
                      aria-label="Reset database"
                      data-tooltip="Reset to the last imported database"
                    >
                      <Icon name="reset" />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={askClearWorkspace}
                      disabled={phase === 'resetting'}
                      aria-label="Clear workspace"
                      data-tooltip="Clear all and start fresh"
                    >
                      <Icon name="trash" />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setImportOpen(true)}
                      disabled={phase !== 'ready'}
                      aria-label="Import database"
                      data-tooltip="Import a database"
                    >
                      <Icon name="download" />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-expanded={!collapsed}
                  aria-controls="db-panel-body"
                  aria-label={collapsed ? 'Show database panel' : 'Hide database panel'}
                  data-tooltip={collapsed ? 'Show' : 'Hide'}
                  data-tooltip-pos="end"
                  onClick={() => updateWs((w) => ({ ...w, ui: { ...w.ui, sidebarCollapsed: !w.ui.sidebarCollapsed } }))}
                >
                  <Icon name="sidebar" />
                </button>
              </div>
              <div className="db-panel-body" id="db-panel-body" hidden={collapsed}>
                <SchemaTree schema={schema} stale={schemaStale} unavailable={phase === 'failed'} />
                <div className="db-panel-footer">
                  <p className="db-facts">
                    {info ? (
                      <>
                        PostgreSQL {info.postgresVersion} · {base.name}
                        {!info.persistent && ' · temporary'}
                      </>
                    ) : phase === 'failed' ? (
                      'Not running'
                    ) : (
                      'Starting…'
                    )}
                  </p>
                </div>
              </div>
            </aside>

          <div className="main-col" ref={mainCol} style={{ gridTemplateRows: `minmax(140px, ${ui?.editorFraction ?? 0.55}fr) auto minmax(140px, ${1 - (ui?.editorFraction ?? 0.55)}fr)` }}>
            <section className="panel editor-panel" id="editor-panel" aria-labelledby="query-title">
              <div className="panel-header editor-header">
                <h2 id="query-title">Query</h2>
                <div className="run-actions">
                  <span className="db-status" data-state={status.state}>
                    {status.text}
                  </span>
                  {phase === 'running' ? (
                    <button type="button" id="run" data-action="stop" onClick={stop} title="Stop: restarts the database engine">
                      <Icon name="stop" /> Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      id="run"
                      data-action="run"
                      onClick={() => void run()}
                      disabled={phase !== 'ready'}
                      title="Run the selection, or the whole query (Ctrl/⌘ + Enter)"
                    >
                      <Icon name="play" /> Run
                    </button>
                  )}
                </div>
              </div>
              <div className="editor-body" id="editor-body">
                {ws && <SqlEditor ref={editor} initialText={ws.sql} label="SQL query" onChange={onEdit} onRun={() => void run()} />}
              </div>
            </section>
            <Splitter
              fraction={ui?.editorFraction ?? 0.55}
              containerRef={mainCol}
              onChange={(f) => updateWs((w) => ({ ...w, ui: { ...w.ui, editorFraction: f } }))}
            />
            <ResultsPanel run={lastRun} onGoToError={goToError} blocking={failurePanel} />
          </div>
        </div>
        <p className="workspace-motto">One database. One query at a time.</p>
      </main>

      <footer className="app-footer">
        <a href="https://github.com/hanze-hbo-ict/krash">Krash on GitHub</a>
        <span>No code completion or AI assistance. Everything runs in your browser, and your query is kept only in this tab.</span>
        <span className="storage-warning" hidden={!sessionMissing}>
          Session storage is unavailable: your query will be lost on reload.
        </span>
        <span className="storage-warning" hidden={sessionMissing || !ws || !!ws.dbName}>
          Database storage is unavailable: database changes will be lost on reload.
        </span>
        <a className="footer-licenses" href="./THIRD_PARTY_NOTICES.txt">
          Licenses
        </a>
      </footer>

      <div className="visually-hidden" aria-live="polite" role="status">
        {announce}
      </div>
      <div className="visually-hidden" aria-live="polite">
        {phase === 'ready' && txStatus !== 'I' ? txText(txStatus) : ''}
      </div>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <ImportDatabaseDialog
        open={importOpen}
        busy={phase === 'resetting'}
        error={importError}
        onClose={() => {
          setImportOpen(false)
          setImportError('')
        }}
        onImport={(sql) => void importDb(sql)}
      />
    </>
  )
}

function FailurePanel({
  failure,
  persistent,
  onRetry,
  onNewDb,
  onMemory,
}: {
  failure: WorkerFailure
  persistent: boolean
  onRetry: () => void
  onNewDb: () => void
  onMemory: () => void
}) {
  const advice: Record<string, string> = {
    wasm: 'Reload the page. If this keeps happening, this computer may block WebAssembly or the Krash files are incomplete.',
    storage: 'The browser could not open its database storage. Try again, start a new database, or use a temporary one.',
    seed: 'Try again.',
    crash: 'Try again, or start a new database.',
    internal: 'Something went wrong while starting the database.',
  }
  return (
    <section className="failure-panel" role="alert" aria-labelledby="failure-title">
      <h2 id="failure-title">The database is not available</h2>
      <p>{failure.message}</p>
      <p>{advice[failure.kind] ?? advice.internal}</p>
      {failure.detail && (
        <details>
          <summary>Technical details</summary>
          <pre>{failure.detail}</pre>
        </details>
      )}
      <p>Your query is safe and you can keep editing it.</p>
      <div className="failure-actions">
        <button type="button" className="primary" onClick={onRetry}>
          Try again
        </button>
        {persistent && failure.kind !== 'wasm' && (
          <button type="button" onClick={onNewDb}>
            Start a new database
          </button>
        )}
        {persistent && failure.kind !== 'wasm' && (
          <button type="button" onClick={onMemory}>
            Use a temporary database
          </button>
        )}
      </div>
    </section>
  )
}
