import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'
import type { AnswerDoc } from '../workspace/types'
import { ImportError, parseAnswers, type ImportResult } from '../workspace/exportAnswers'
import type { DbInfo } from '../db/protocol'

// ---- Confirm ----------------------------------------------------------------

export interface ConfirmRequest {
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  return (
    <Modal open={!!request} title={request?.title ?? 'Confirm'} onClose={onClose} initialFocus="confirm-cancel">
      {request && (
        <>
          <div className="modal-body">{request.body}</div>
          <div className="modal-actions">
            <button
              type="button"
              className={request.danger ? 'danger' : 'primary'}
              onClick={() => {
                onClose()
                request.onConfirm()
              }}
            >
              {request.confirmLabel}
            </button>
            <button type="button" id="confirm-cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

// ---- Export -----------------------------------------------------------------

interface ExportProps {
  open: boolean
  onClose: () => void
  docs: AnswerDoc[]
  activeDoc: AnswerDoc | null
  fileName: string
  buildText: () => string
  onDownload: () => void
  lastExportAt: string | null
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function ExportDialog({ open, onClose, docs, activeDoc, fileName, buildText, onDownload, lastExportAt }: ExportProps) {
  const [message, setMessage] = useState('')
  const preview = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (open) setMessage('')
  }, [open])
  const text = open ? buildText() : ''
  const copyFallback = () => {
    preview.current?.focus()
    preview.current?.select()
    setMessage('Copying is blocked in this browser. The text is selected: press Ctrl/⌘ + C.')
  }
  return (
    <Modal
      open={open}
      title="Export answers"
      onClose={onClose}
      wide
      initialFocus="export-download"
      description={
        <p>
          Saves all {docs.length} answers as one <code>.sql</code> file, in tab order. <strong>Downloading is not submitting:</strong> upload the file
          to your exam platform yourself.
        </p>
      }
    >
      <textarea ref={preview} className="export-preview" readOnly spellCheck={false} value={text} aria-label="Preview of the exported file" />
      <p className="modal-message" role="status">
        {message || (lastExportAt ? `Last exported at ${new Date(lastExportAt).toLocaleTimeString('en-GB')}.` : 'Not exported yet in this session.')}
      </p>
      <div className="modal-actions">
        <span className="modal-actions-note">{fileName}</span>
        <button
          id="export-download"
          type="button"
          className="primary"
          onClick={() => {
            onDownload()
            setMessage(`Downloaded ${fileName}. This is not a submission: upload the file via your exam platform.`)
          }}
        >
          Download .sql
        </button>
        <button
          type="button"
          onClick={async () => ((await copyText(text)) ? setMessage('All answers copied to the clipboard.') : copyFallback())}
        >
          Copy all
        </button>
        {activeDoc && (
          <button
            type="button"
            onClick={async () =>
              (await copyText(activeDoc.sql)) ? setMessage(`“${activeDoc.name}” copied to the clipboard.`) : copyFallback()
            }
          >
            Copy current answer
          </button>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

// ---- Import -----------------------------------------------------------------

interface ImportProps {
  open: boolean
  onClose: () => void
  examId: string
  datasetId: string
  onImport: (result: ImportResult, mode: 'replace' | 'add') => void
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024

export function ImportDialog({ open, onClose, examId, datasetId, onImport }: ImportProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) {
      setText('')
      setError('')
    }
  }, [open])

  let parsed: ImportResult | null = null
  let parseError = ''
  if (text.trim()) {
    try {
      parsed = parseAnswers(text)
    } catch (e) {
      parseError = e instanceof ImportError ? e.message : 'The text could not be read.'
    }
  }
  const warnings: string[] = []
  if (parsed?.examId && parsed.examId !== examId) warnings.push(`This export is from exam “${parsed.examId}”, not “${examId}”.`)
  if (parsed?.datasetId && parsed.datasetId !== datasetId) warnings.push(`It was made with dataset “${parsed.datasetId}”.`)

  return (
    <Modal
      open={open}
      title="Import answers"
      onClose={onClose}
      wide
      initialFocus="import-file"
      description={<p>Open or paste a file exported from Krash. Imported SQL is put into answer tabs and is not run.</p>}
    >
      <div className="import-file-row">
        <label htmlFor="import-file">Krash export file</label>
        <input
          id="import-file"
          type="file"
          accept=".sql,.txt,text/plain,application/sql"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            if (f.size > MAX_IMPORT_BYTES) {
              setError('That file is too large to be a Krash answer export.')
              return
            }
            setError('')
            setText(await f.text())
          }}
        />
      </div>
      <label className="visually-hidden" htmlFor="import-text">
        Export text
      </label>
      <textarea
        id="import-text"
        className="export-preview"
        spellCheck={false}
        autoComplete="off"
        value={text}
        placeholder="…or paste the exported text here (it starts with “-- Krash answers”)."
        onChange={(e) => setText(e.target.value)}
      />
      <div className="modal-message" role="status" aria-live="polite">
        {error && <p className="text-error">{error}</p>}
        {parseError && <p className="text-error">{parseError}</p>}
        {parsed && (
          <p>
            Found {parsed.answers.length} answer{parsed.answers.length === 1 ? '' : 's'}: {parsed.answers.map((a) => `“${a.name || 'Untitled'}”`).join(', ')}.
          </p>
        )}
        {warnings.map((w) => (
          <p key={w} className="text-warn">
            {w}
          </p>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="danger" disabled={!parsed || parsed.answers.length === 0} onClick={() => parsed && onImport(parsed, 'replace')}>
          Replace all answers
        </button>
        <button type="button" disabled={!parsed || parsed.answers.length === 0} onClick={() => parsed && onImport(parsed, 'add')}>
          Add as new tabs
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

// ---- Workspace ----------------------------------------------------------------

interface WorkspaceProps {
  open: boolean
  onClose: () => void
  onResetDb: () => void
  onClearAnswers: () => void
  onStartFresh: () => void
  dbReady: boolean
}

export function WorkspaceDialog({ open, onClose, onResetDb, onClearAnswers, onStartFresh, dbReady }: WorkspaceProps) {
  return (
    <Modal open={open} title="Workspace" onClose={onClose} initialFocus="ws-close">
      <ul className="ws-actions">
        <li>
          <div>
            <h3>Reset database</h3>
            <p>Restore the original exam dataset. Your answers and tabs are kept.</p>
          </div>
          <button type="button" onClick={onResetDb} disabled={!dbReady}>
            Reset database…
          </button>
        </li>
        <li>
          <div>
            <h3>Clear answers</h3>
            <p>Remove all answer tabs and their SQL. The database is not changed.</p>
          </div>
          <button type="button" onClick={onClearAnswers}>
            Clear answers…
          </button>
        </li>
        <li>
          <div>
            <h3>Start fresh / clear workspace</h3>
            <p>Delete all answers and this tab’s database from the browser. Use this at the start of an exam, or after you have submitted.</p>
          </div>
          <button type="button" className="danger" onClick={onStartFresh}>
            Clear workspace…
          </button>
        </li>
      </ul>
      <div className="modal-actions">
        <button type="button" id="ws-close" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

// ---- Help / About -------------------------------------------------------------

interface HelpProps {
  open: boolean
  onClose: () => void
  title: string
  examId: string
  info: DbInfo | null
  instructions: string | null
  persistent: boolean
}

export function HelpDialog({ open, onClose, title, examId, info, instructions, persistent }: HelpProps) {
  const [storage, setStorage] = useState<string>('')
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const est = await navigator.storage?.estimate?.()
        const persisted = await navigator.storage?.persisted?.()
        if (cancelled) return
        const mb = (n?: number) => (n === undefined ? '?' : `${(n / 1024 / 1024).toFixed(1)} MB`)
        setStorage(`Using ${mb(est?.usage)} of ${mb(est?.quota)}; persistent storage ${persisted ? 'granted' : 'not granted'} (diagnostic only).`)
      } catch {
        if (!cancelled) setStorage('Storage information is not available.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  return (
    <Modal open={open} title="About Krash" onClose={onClose} wide initialFocus="help-close">
      <div className="help">
        <p>
          Krash is a small PostgreSQL workspace. A real PostgreSQL engine (PGlite) runs inside this browser tab; nothing you type is sent anywhere. There is
          no code completion and no AI assistance.
        </p>
        {instructions && (
          <section>
            <h3>Instructions</h3>
            <p className="pre-line">{instructions}</p>
          </section>
        )}
        <section>
          <h3>Keyboard</h3>
          <dl className="keys">
            <dt>
              <kbd>{mod}</kbd> + <kbd>Enter</kbd>
            </dt>
            <dd>Run the selection, or the whole answer if nothing is selected</dd>
            <dt>
              <kbd>Esc</kbd> then <kbd>Tab</kbd>
            </dt>
            <dd>Leave the editor (Tab inside the editor indents)</dd>
            <dt>
              <kbd>←</kbd> <kbd>→</kbd>
            </dt>
            <dd>Switch answer tabs or result tabs when a tab is focused</dd>
            <dt>
              <kbd>F2</kbd> / <kbd>Delete</kbd>
            </dt>
            <dd>Rename / delete the focused answer tab</dd>
          </dl>
        </section>
        <section>
          <h3>Saving and submitting</h3>
          <ul>
            <li>
              Answers are saved in this browser tab and survive a reload. {persistent ? 'The database also survives a reload.' : 'The database does not survive a reload in this browser.'}
            </li>
            <li>Closing the tab loses the answers. Browsers can also clear storage at any time: this is not a backup.</li>
            <li>
              <strong>Export regularly</strong> and upload the exported file via your exam platform. Krash never submits anything.
            </li>
          </ul>
        </section>
        <section>
          <h3>How SQL is run</h3>
          <ul>
            <li>All answer tabs share one database. Running SQL changes it, just like a normal PostgreSQL session.</li>
            <li>
              The text is sent to PostgreSQL as a single script. If a statement fails, the statements before it in the same Run are rolled back (unless the
              script used explicit <code>BEGIN</code>/<code>COMMIT</code>).
            </li>
            <li>At most a limited number of rows per result is shown; the full row count is always reported.</li>
            <li>
              <strong>Stop</strong> restarts the database engine: the interrupted Run and any open transaction are discarded.
            </li>
            <li>
              Not supported: <code>COPY … FROM STDIN</code>, psql commands such as <code>\d</code>, extensions, roles, and server administration.
            </li>
          </ul>
        </section>
        <section>
          <h3>Version</h3>
          <dl className="facts">
            <dt>Krash</dt>
            <dd>{__APP_VERSION__}</dd>
            <dt>PostgreSQL</dt>
            <dd>{info ? `${info.postgresVersion} (PGlite ${info.pgliteVersion})` : 'not started'}</dd>
            <dt>Exam</dt>
            <dd>
              {title} ({examId})
            </dd>
            <dt>Dataset</dt>
            <dd>{info?.datasetId ?? '—'}</dd>
            <dt>Storage</dt>
            <dd>{storage || '…'}</dd>
          </dl>
          <p>
            <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">
              Third-party licenses
            </a>
          </p>
        </section>
      </div>
      <div className="modal-actions">
        <button type="button" id="help-close" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
