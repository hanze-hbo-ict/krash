import { useEffect, useState, type ReactNode } from 'react'
import { Modal } from './Modal'

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

// ---- Import database ----------------------------------------------------------

/** Imported SQL is kept in sessionStorage so Reset and reload can use it again. */
export const MAX_DATASET_BYTES = 2 * 1024 * 1024

interface ImportDbProps {
  open: boolean
  onClose: () => void
  onImport: (sql: string) => void
}

export function ImportDatabaseDialog({ open, onClose, onImport }: ImportDbProps) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (open) setText('')
  }, [open])

  const tooLarge = new Blob([text]).size > MAX_DATASET_BYTES

  return (
    <Modal
      open={open}
      title="Import database"
      onClose={onClose}
      wide
      initialFocus="import-text"
      description={
        <p>
          Paste a SQL script. The current database is cleared and the script is run on an empty database. Your queries are kept, and
          Reset returns to this imported database.
        </p>
      }
    >
      <label className="visually-hidden" htmlFor="import-text">
        SQL script
      </label>
      <textarea
        id="import-text"
        className="export-preview"
        spellCheck={false}
        autoComplete="off"
        value={text}
        placeholder="create table … ;"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="modal-message" role="status" aria-live="polite">
        {tooLarge && <p className="text-error">The script is larger than 2 MB, which is too large to import.</p>}
      </div>
      <div className="modal-actions">
        <button type="button" className="danger" disabled={!text.trim() || tooLarge} onClick={() => onImport(text)}>
          Clear database and import
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
