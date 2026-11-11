import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { examConfig } from '../exam/examConfig'
import { DbClient, DbFailure } from '../db/dbClient'
import type { DbInfo, SchemaNamespace, TxStatus, WorkerFailure } from '../db/protocol'
import { dbNameFor, dbNameFromIdb } from '../db/storageNames'
import { offsetToLineCol, pgPositionToOffset } from '../db/sqlLexer'
import type { AnswerDoc, ThemeChoice, Workspace } from '../workspace/types'
import {
  createWorkspace,
  findOrphans,
  HEARTBEAT_INTERVAL_MS,
  loadWorkspace,
  newDoc,
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
import { nextQuestionName, safeFileName, sanitizeName, uniqueName } from '../workspace/names'
import { exportAnswers, type ImportResult } from '../workspace/exportAnswers'
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor'
import { AnswerTabs } from '../components/AnswerTabs'
import { SchemaTree } from '../components/SchemaTree'
import { ResultsPanel } from '../components/ResultsPanel'
import { Splitter } from '../components/Splitter'
import { ConfirmDialog, ExportDialog, HelpDialog, ImportDialog, WorkspaceDialog, type ConfirmRequest } from '../components/Dialogs'
import { Icon, ThemeIcon } from '../components/Icon'
import type { ErrorLocation, RunRecord } from './runTypes'
import { txText } from './describe'

type Phase = 'booting' | 'starting' | 'ready' | 'running' | 'restarting' | 'resetting' | 'failed'

interface Banner {
  id: string
  level: 'info' | 'warn' | 'error'
  text: string
}

const dataset = examConfig.dataset
const THEME_KEY = 'krash:theme'

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
  const [runs, setRuns] = useState<Record<string, RunRecord>>({})
  const [banners, setBanners] = useState<Banner[]>([])
  const [announce, setAnnounce] = useState('')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [dialog, setDialog] = useState<null | 'export' | 'import' | 'help' | 'workspace'>(null)
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)

  const client = useRef<DbClient | null>(null)
  const saver = useRef<WorkspaceSaver | null>(null)
  const wsRef = useRef<Workspace | null>(null)
  const editor = useRef<SqlEditorHandle>(null)
  const mainCol = useRef<HTMLDivElement>(null)
  const runCounter = useRef(0)
  const activeRun = useRef<number | null>(null)
  const unexported = useRef(false)
  const local = useRef<Storage | null>(null)

  wsRef.current = ws

  const addBanner = useCallback((level: Banner['level'], text: string, id = randomId(6)) => {
    setBanners((b) => [...b.filter((x) => x.id !== id), { id, level, text }])
  }, [])
  const dropBanner = (id: string) => setBanners((b) => b.filter((x) => x.id !== id))

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
    if (!c || !examConfig.features.schemaBrowser) return
    setSchemaStale(true)
    try {
      setSchema(await c.request({ type: 'getSchema' }))
    } catch {
      /* e.g. inside an aborted transaction: keep the previous tree */
    } finally {
      setSchemaStale(false)
    }
  }, [])

  const handleInfo = useCallback(
    (i: DbInfo, context: 'boot' | 'restart' | 'reset' | 'new') => {
      setInfo(i)
      setFailure(null)
      setTxStatus('I')
      dropBanner('mismatch')
      if (i.datasetMismatch !== null) {
        addBanner(
          'warn',
          `This tab’s database was made for a different dataset (“${i.datasetMismatch}”). Use Reset database to load “${dataset.id}”. Your answers are not affected.`,
          'mismatch',
        )
      }
      if (context === 'boot' && !i.seeded && i.datasetMismatch === null) {
        addBanner('info', 'Welcome back: your answers and your database were restored from this tab.', 'restored')
      }
      if (context === 'restart' && i.seeded) {
        addBanner('warn', 'The database storage was missing, so the original exam dataset was loaded again.', 'reseeded')
      }
    },
    [addBanner],
  )

  const openDb = useCallback(
    async (dbName: string | null, context: 'boot' | 'restart') => {
      const c = client.current!
      setPhase(context === 'boot' ? 'starting' : 'restarting')
      try {
        const i = await c.request({ type: 'init', dbName, dataset })
        handleInfo(i, context)
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

  const restartAfterLoss = useCallback(
    async (reason: 'stopped' | 'crashed') => {
      const w = wsRef.current
      if (!w) return
      const ok = await openDb(w.dbName, 'restart')
      if (ok) {
        addBanner(
          reason === 'stopped' ? 'info' : 'warn',
          reason === 'stopped'
            ? 'Stopped. The database was reopened from its last saved state: the interrupted Run and any open transaction were discarded.'
            : 'The PostgreSQL engine stopped unexpectedly and was restarted from its last saved state. The last Run and any open transaction were discarded.',
          'restart',
        )
      }
    },
    [openDb, addBanner],
  )

  // ---- Boot ----------------------------------------------------------------------
  useEffect(() => {
    let disposed = false
    const session = safeStorage('session')
    local.current = safeStorage('local')
    const idbAvailable = typeof indexedDB !== 'undefined'
    const persistentPossible = !!session && idbAvailable

    saver.current = new WorkspaceSaver(session, (s, e) => {
      setSaveState(s)
      setSaveError(e ?? '')
    })
    const c = new DbClient()
    client.current = c
    c.onCrash = () => {
      setRuns((r) => {
        const id = activeRun.current
        if (id === null) return r
        const entry = Object.entries(r).find(([, v]) => v.id === id)
        if (!entry) return r
        return { ...r, [entry[0]]: { ...entry[1], status: 'done', failure: { kind: 'crash', message: 'The PostgreSQL engine stopped unexpectedly while running this SQL.' } } }
      })
      activeRun.current = null
      void restartAfterLoss('crashed')
    }

    ;(async () => {
      let w = loadWorkspace(session)
      const restored = !!w
      if (!w) w = createWorkspace(examConfig.initialTabs, persistentPossible)
      if (w.dbName && !idbAvailable) w = { ...w, dbName: null }

      // A duplicated tab carries a copy of this session: give it its own database.
      if (w.dbName) {
        const lock = await acquireSessionLock(w.sessionId)
        if (lock === 'held-elsewhere') {
          const sessionId = randomId(16)
          w = { ...w, sessionId, generation: 1, dbName: dbNameFor(sessionId, 1) }
          await acquireSessionLock(sessionId, 100)
          addBanner(
            'warn',
            'This looks like a duplicated tab. Your answers were copied, but this tab has its own fresh database. The two tabs no longer share anything.',
            'duplicate',
          )
        }
      }
      if (disposed) return
      if (!session) {
        addBanner('error', 'Session storage is unavailable: answers will be lost on reload. Export often.', 'nostorage')
      } else if (!w.dbName) {
        addBanner('warn', 'Browser database storage is unavailable: database changes will not survive a reload. Answers are still saved.', 'memdb')
      }
      writeHeartbeat(local.current, w.sessionId)
      setWs(w)
      saver.current!.schedule(w)
      saver.current!.flush()
      await openDb(w.dbName, 'boot')
      if (!restored) dropBanner('restored')
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

  // Starting can be slow on old machines; say so instead of looking stuck.
  useEffect(() => {
    if (phase !== 'starting' && phase !== 'restarting') {
      dropBanner('slow')
      return
    }
    const t = setTimeout(
      () => addBanner('info', 'Still starting PostgreSQL… This can take a while on a slow computer. If nothing happens within a minute, reload the page.', 'slow'),
      30_000,
    )
    return () => clearTimeout(t)
  }, [phase, addBanner])

  // Warn before closing the tab with answers that were not exported.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      saver.current?.flush()
      if (unexported.current) {
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

  // ---- Answers ---------------------------------------------------------------------
  const docs = ws?.docs ?? []
  const activeDoc = docs.find((d) => d.id === ws?.activeId) ?? docs[0] ?? null

  const onEdit = useCallback(
    (docId: string, text: string) => {
      unexported.current = true
      updateWs((w) => ({ ...w, docs: w.docs.map((d) => (d.id === docId ? { ...d, sql: text } : d)) }))
    },
    [updateWs],
  )

  const selectDoc = (id: string) => updateWs((w) => (w.activeId === id ? w : { ...w, activeId: id }))

  const addDoc = () => {
    updateWs((w) => {
      if (w.docs.length >= 50) {
        addBanner('warn', 'You have reached the maximum of 50 answer tabs.', 'maxdocs')
        return w
      }
      const d = newDoc(nextQuestionName(w.docs.map((x) => x.name)))
      return { ...w, docs: [...w.docs, d], activeId: d.id }
    })
    setTimeout(() => editor.current?.focus(), 0)
  }

  const renameDoc = (id: string, raw: string) => {
    updateWs((w) => {
      const others = w.docs.filter((d) => d.id !== id).map((d) => d.name)
      const name = sanitizeName(raw)
      if (!name) return w
      const unique = uniqueName(name, others)
      return { ...w, docs: w.docs.map((d) => (d.id === id ? { ...d, name: unique } : d)) }
    })
    unexported.current = true
  }

  const requestDelete = (id: string) => {
    const doc = wsRef.current?.docs.find((d) => d.id === id)
    if (!doc) return
    setConfirm({
      title: 'Delete answer?',
      body: (
        <p>
          Delete “{doc.name}”{doc.sql.trim() ? ' and its SQL' : ''}? This cannot be undone. The database is not changed.
        </p>
      ),
      confirmLabel: 'Delete answer',
      danger: true,
      onConfirm: () => {
        updateWs((w) => {
          let rest = w.docs.filter((d) => d.id !== id)
          if (rest.length === 0) rest = [newDoc(nextQuestionName([]))]
          const idx = w.docs.findIndex((d) => d.id === id)
          const activeId = w.activeId === id ? rest[Math.min(idx, rest.length - 1)]!.id : w.activeId
          return { ...w, docs: rest, activeId }
        })
        setRuns((r) => {
          const { [id]: _removed, ...rest } = r
          return rest
        })
        unexported.current = true
        setAnnounce(`Deleted ${doc.name}.`)
      },
    })
  }

  // ---- Running SQL -------------------------------------------------------------------
  const run = useCallback(async () => {
    const c = client.current
    const w = wsRef.current
    if (!c || !w || phase !== 'ready' || !editor.current) return
    const doc = w.docs.find((d) => d.id === w.activeId)
    if (!doc) return
    const target = editor.current.getRunTarget()
    const id = ++runCounter.current
    activeRun.current = id
    const fromLine = offsetToLineCol(target.docText, target.offset).line
    const toLine = offsetToLineCol(target.docText, target.offset + target.sql.length).line
    const record: RunRecord = {
      id,
      kind: 'query',
      docId: doc.id,
      docName: doc.name,
      isSelection: target.isSelection,
      lines: { from: fromLine, to: toLine },
      startedAt: Date.now(),
      status: 'running',
      outcome: null,
      failure: null,
      errorLocation: null,
    }
    setRuns((r) => ({ ...r, [doc.id]: record }))
    setPhase('running')
    setAnnounce('Running…')
    dropBanner('restart')
    try {
      const outcome = await c.request({ type: 'execute', sql: target.sql, maxRows: examConfig.maxRows })
      if (activeRun.current !== id) return
      const errorLocation = outcome.error ? errorLocationFor(target.sql, target.offset, target.docText, outcome.error.position) : null
      setRuns((r) => ({ ...r, [doc.id]: { ...record, status: 'done', outcome, errorLocation } }))
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
      const f = err instanceof DbFailure ? err.failure : { kind: 'internal' as const, message: String(err) }
      setRuns((r) => ({ ...r, [doc.id]: { ...record, status: 'done', failure: f } }))
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
    void restartAfterLoss('stopped')
  }

  const preview = async (schemaName: string, table: string) => {
    const c = client.current
    const w = wsRef.current
    if (!c || !w || phase !== 'ready') return
    const id = ++runCounter.current
    activeRun.current = id
    const base: RunRecord = {
      id,
      kind: 'preview',
      docId: w.activeId,
      docName: `${schemaName}.${table}`,
      isSelection: false,
      lines: { from: 1, to: 1 },
      startedAt: Date.now(),
      status: 'running',
      outcome: null,
      failure: null,
      errorLocation: null,
    }
    setPhase('running')
    try {
      const outcome = await c.request({ type: 'previewTable', schema: schemaName, table, limit: 20 })
      if (activeRun.current === id) setRuns((r) => ({ ...r, [w.activeId]: { ...base, status: 'done', outcome } }))
      setPhase('ready')
    } catch (err) {
      const f = err instanceof DbFailure ? err.failure : { kind: 'internal' as const, message: String(err) }
      if (activeRun.current === id) setRuns((r) => ({ ...r, [w.activeId]: { ...base, status: 'done', failure: f } }))
      if (f.kind !== 'crash' && f.kind !== 'cancelled') setPhase('ready')
    } finally {
      if (activeRun.current === id) activeRun.current = null
    }
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

  // ---- Reset / clear -----------------------------------------------------------------
  const doResetDb = async () => {
    const c = client.current
    const w = wsRef.current
    if (!c || !w) return
    setDialog(null)
    setPhase('resetting')
    setAnnounce('Resetting the database…')
    const generation = w.generation + 1
    const newName = w.dbName ? dbNameFor(w.sessionId, generation) : null
    const oldName = w.dbName
    try {
      const i = await c.request({ type: 'createFresh', dbName: newName, dataset })
      const next = { ...w, dbName: newName, generation }
      setWs(next)
      saver.current?.schedule(next)
      saver.current?.flush()
      handleInfo(i, 'reset')
      setPhase('ready')
      setRuns({})
      dropBanner('restart')
      addBanner('info', 'The database was reset to the original exam dataset. Your answers were kept.', 'reset')
      setAnnounce('The database was reset.')
      await refreshSchema()
      if (oldName) await c.request({ type: 'dropDatabase', dbName: oldName }).catch(() => {})
    } catch (err) {
      const f = err instanceof DbFailure ? err.failure : { kind: 'internal' as const, message: String(err) }
      if (f.kind === 'crash') return // the crash handler restarts the previous database
      setPhase(info ? 'ready' : 'failed')
      addBanner('error', `Reset failed: ${f.message} Your previous database is still in use.`, 'reset')
    }
  }

  const askResetDb = () =>
    setConfirm({
      title: 'Reset database?',
      body: (
        <p>
          This removes every change you made to the database (tables, rows, views…) and restores the original exam dataset “{dataset.id}”. Your answer tabs
          and their SQL are kept.
        </p>
      ),
      confirmLabel: 'Reset database',
      danger: true,
      onConfirm: () => void doResetDb(),
    })

  const askClearAnswers = () =>
    setConfirm({
      title: 'Clear all answers?',
      body: (
        <p>
          This deletes all {wsRef.current?.docs.length ?? 0} answer tabs and their SQL. It cannot be undone; export first if you want to keep them. The database
          is not changed.
        </p>
      ),
      confirmLabel: 'Clear answers',
      danger: true,
      onConfirm: () => {
        setDialog(null)
        updateWs((w) => {
          const fresh = createWorkspace(examConfig.initialTabs, false)
          return { ...w, docs: fresh.docs, activeId: fresh.activeId }
        })
        setRuns({})
        unexported.current = false
        setAnnounce('All answers were cleared.')
      },
    })

  const askStartFresh = () =>
    setConfirm({
      title: 'Clear this workspace?',
      body: (
        <>
          <p>This deletes all answers and this tab’s database from the browser, then starts an empty workspace with the original dataset.</p>
          <p>
            <strong>Export your answers first</strong> if you still need them. This cannot be undone.
          </p>
        </>
      ),
      confirmLabel: 'Clear workspace',
      danger: true,
      onConfirm: async () => {
        const c = client.current
        const w = wsRef.current
        if (!c || !w) return
        setDialog(null)
        setPhase('resetting')
        unexported.current = false
        try {
          await c.request({ type: 'close' })
          if (w.dbName) await c.request({ type: 'dropDatabase', dbName: w.dbName })
        } catch {
          /* fall through: a stale database is removed by orphan cleanup later */
        }
        saver.current?.clear()
        removeHeartbeat(local.current, w.sessionId)
        window.location.reload()
      },
    })

  // ---- Import / export ------------------------------------------------------------------
  const exportFileName = useMemo(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
    return `${safeFileName(`krash-answers-${examConfig.examId}-${stamp}`)}.sql`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog])

  const buildExport = () =>
    exportAnswers(wsRef.current?.docs ?? [], { examId: examConfig.examId, datasetId: dataset.id, exportedAt: new Date() })

  const download = () => {
    const blob = new Blob([buildExport()], { type: 'application/sql;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exportFileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    unexported.current = false
    updateWs((w) => ({ ...w, lastExportAt: new Date().toISOString() }))
    setAnnounce(`Downloaded ${exportFileName}. This is not a submission.`)
  }

  const doImport = (result: ImportResult, mode: 'replace' | 'add') => {
    const apply = () => {
      updateWs((w) => {
        const base = mode === 'replace' ? [] : w.docs
        const taken = base.map((d) => d.name)
        const added: AnswerDoc[] = result.answers.slice(0, Math.max(0, 50 - base.length)).map((a) => {
          const name = uniqueName(a.name, taken, 'Answer')
          taken.push(name)
          return newDoc(name, a.sql)
        })
        const docs = [...base, ...added]
        if (docs.length === 0) return w
        return { ...w, docs, activeId: added[0]?.id ?? w.activeId }
      })
      if (mode === 'replace') setRuns({})
      unexported.current = true
      setDialog(null)
      setAnnounce(`Imported ${result.answers.length} answers. Nothing was run.`)
      addBanner('info', `Imported ${result.answers.length} answer${result.answers.length === 1 ? '' : 's'}. Nothing was run.`, 'import')
    }
    if (mode === 'replace') {
      setConfirm({
        title: 'Replace all answers?',
        body: <p>Your current {wsRef.current?.docs.length ?? 0} answer tabs will be replaced by the imported answers. The database is not changed.</p>,
        confirmLabel: 'Replace answers',
        danger: true,
        onConfirm: apply,
      })
    } else apply()
  }

  // ---- Render ---------------------------------------------------------------------------
  const goToError = (offset: number) => editor.current?.moveTo(offset)
  const ui = ws?.ui
  const collapsed = !!ui?.sidebarCollapsed || !examConfig.features.schemaBrowser
  const run_ = activeDoc ? runs[activeDoc.id] ?? null : null

  const status = (() => {
    switch (phase) {
      case 'booting':
      case 'starting':
        return { state: 'loading', text: 'Starting PostgreSQL…' }
      case 'running':
        return { state: 'running', text: 'Running…' }
      case 'restarting':
        return { state: 'running', text: 'Restarting PostgreSQL…' }
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
          ? 'Save failed: export now'
          : 'Not saved: export often'

  const cycleTheme = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))
  const themeLabel = { system: 'System appearance', light: 'Light appearance', dark: 'Dark appearance' }[theme]
  const nextThemeLabel = { system: 'light', light: 'dark', dark: 'system' }[theme]

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
        <nav className="header-actions" aria-label="Workspace">
          {examConfig.features.answerImport && (
            <button type="button" onClick={() => setDialog('import')}>
              <Icon name="download" /> <span>Import</span>
            </button>
          )}
          {examConfig.features.answerExport && (
            <button type="button" className="export-button" onClick={() => setDialog('export')}>
              <Icon name="upload" /> <span>Export answers</span>
            </button>
          )}
          <button type="button" onClick={() => setDialog('workspace')}>
            <Icon name="workspace" /> <span>Workspace</span>
          </button>
          <button type="button" onClick={() => setDialog('help')}>
            <Icon name="help" /> <span>Help</span>
          </button>
          <button
            type="button"
            className="theme-control"
            onClick={cycleTheme}
            aria-label={`${themeLabel}. Switch to ${nextThemeLabel} appearance`}
            title={`${themeLabel}. Switch to ${nextThemeLabel} appearance`}
          >
            <ThemeIcon choice={theme} />
          </button>
        </nav>
      </header>

      <main>
        <div className="workspace-heading">
          <p className="eyebrow">
            POSTGRESQL WORKSPACE<span className="eyebrow-title"> · {examConfig.title}</span>
          </p>
          <p className={`save-state save-${saveState}`} role="status" title={saveError || undefined}>
            {saveText}
            {ws?.lastExportAt ? (
              <span className="export-state"> · exported {new Date(ws.lastExportAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
            ) : (
              <span className="export-state"> · not exported yet</span>
            )}
          </p>
        </div>

        {banners.length > 0 && (
          <ul className="banners" aria-label="Notifications">
            {banners.map((b) => (
              <li key={b.id} className={`banner banner-${b.level}`}>
                <span>
                  <strong className="banner-level">{b.level === 'error' ? 'Important: ' : b.level === 'warn' ? 'Note: ' : ''}</strong>
                  {b.text}
                </span>
                <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => dropBanner(b.id)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="icon">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        {phase === 'failed' && failure && (
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
              addBanner('warn', 'Using a temporary database: database changes will not survive a reload. Answers are still saved.', 'memdb')
              await openDb(null, 'boot')
            }}
          />
        )}

        <div className={`workspace${collapsed ? ' sidebar-collapsed' : ''}`}>
          {examConfig.features.schemaBrowser && (
            <aside className="panel db-panel" aria-labelledby="db-title">
              <div className="panel-header">
                <h2 id="db-title">Database</h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-expanded={!collapsed}
                  aria-controls="db-panel-body"
                  aria-label={collapsed ? 'Show database panel' : 'Hide database panel'}
                  data-tooltip={collapsed ? 'Show' : 'Hide'}
                  onClick={() => updateWs((w) => ({ ...w, ui: { ...w.ui, sidebarCollapsed: !w.ui.sidebarCollapsed } }))}
                >
                  <Icon name="sidebar" />
                </button>
              </div>
              <div className="db-panel-body" id="db-panel-body" hidden={collapsed}>
                <SchemaTree schema={schema} stale={schemaStale} onPreview={examConfig.features.tablePreview ? preview : undefined} />
                <div className="db-panel-footer">
                  <p className="db-facts">
                    {info ? (
                      <>
                        PostgreSQL {info.postgresVersion} · {info.datasetId}
                        {!info.persistent && ' · temporary'}
                      </>
                    ) : (
                      'Starting…'
                    )}
                  </p>
                  <button type="button" onClick={askResetDb} disabled={phase !== 'ready'}>
                    <Icon name="reset" /> Reset database
                  </button>
                </div>
              </div>
            </aside>
          )}

          <div className="main-col" ref={mainCol} style={{ gridTemplateRows: `minmax(140px, ${ui?.editorFraction ?? 0.55}fr) auto minmax(140px, ${1 - (ui?.editorFraction ?? 0.55)}fr)` }}>
            <section className="panel editor-panel" id="editor-panel" aria-label="SQL editor">
              <div className="panel-header editor-header">
                {ws && activeDoc && (
                  <AnswerTabs
                    docs={docs}
                    activeId={activeDoc.id}
                    onSelect={selectDoc}
                    onAdd={addDoc}
                    onRename={renameDoc}
                    onRequestDelete={requestDelete}
                    panelId="editor-body"
                  />
                )}
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
                      title="Run the selection, or the whole answer (Ctrl/⌘ + Enter)"
                    >
                      <Icon name="play" /> Run
                    </button>
                  )}
                </div>
              </div>
              <div
                className="editor-body"
                id="editor-body"
                role="tabpanel"
                aria-labelledby={activeDoc ? `tab-${activeDoc.id}` : undefined}
              >
                {ws && activeDoc && (
                  <SqlEditor
                    ref={editor}
                    docId={activeDoc.id}
                    initialText={activeDoc.sql}
                    label={`SQL for ${activeDoc.name}`}
                    onChange={onEdit}
                    onRun={() => void run()}
                  />
                )}
              </div>
            </section>
            <Splitter
              fraction={ui?.editorFraction ?? 0.55}
              containerRef={mainCol}
              onChange={(f) => updateWs((w) => ({ ...w, ui: { ...w.ui, editorFraction: f } }))}
            />
            <ResultsPanel run={run_} onGoToError={goToError} />
          </div>
        </div>
        <p className="workspace-motto">A few answers. One database.</p>
      </main>

      <footer className="app-footer">
        <span>No code completion or AI assistance.</span>
        <span>PostgreSQL runs in your browser; answers are kept only in this tab. Export regularly and submit via your exam platform.</span>
        <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">
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
      <ExportDialog
        open={dialog === 'export'}
        onClose={() => setDialog(null)}
        docs={docs}
        activeDoc={activeDoc}
        fileName={exportFileName}
        buildText={buildExport}
        onDownload={download}
        lastExportAt={ws?.lastExportAt ?? null}
      />
      <ImportDialog
        open={dialog === 'import'}
        onClose={() => setDialog(null)}
        examId={examConfig.examId}
        datasetId={dataset.id}
        onImport={doImport}
      />
      <WorkspaceDialog
        open={dialog === 'workspace' && !confirm}
        onClose={() => setDialog(null)}
        onResetDb={askResetDb}
        onClearAnswers={askClearAnswers}
        onStartFresh={askStartFresh}
        dbReady={phase === 'ready'}
      />
      <HelpDialog
        open={dialog === 'help'}
        onClose={() => setDialog(null)}
        title={examConfig.title}
        examId={examConfig.examId}
        info={info}
        instructions={examConfig.instructions}
        persistent={!!ws?.dbName}
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
    wasm: 'The PostgreSQL engine files could not be loaded. Reload the page. If this keeps happening, this computer may block WebAssembly or the Krash files are incomplete; tell an invigilator.',
    storage: 'The browser refused or failed to open the database storage. You can try again, start a new database, or continue with a temporary database.',
    seed: 'The exam dataset could not be loaded. Try again; if it keeps failing, tell an invigilator.',
    crash: 'The database engine stopped while starting. Try again or start a new database.',
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
      <p>Your answers are safe and you can keep editing and exporting them.</p>
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
