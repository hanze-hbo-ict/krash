/**
 * Thin wrapper around the native <dialog> element: modal focus handling,
 * Escape to close, focus returns to the opener on close.
 */
import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  wide?: boolean
  /** id of the element to focus initially (defaults to the first focusable). */
  initialFocus?: string
}

export function Modal({ open, title, description, onClose, children, wide, initialFocus }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      opener.current = document.activeElement
      d.showModal()
      if (initialFocus) document.getElementById(initialFocus)?.focus()
    } else if (!open && d.open) {
      d.close()
    }
  }, [open, initialFocus])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    const onCancel = (e: Event) => {
      e.preventDefault()
      onCloseRef.current()
    }
    const onClosed = () => {
      const el = opener.current as HTMLElement | null
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus()
    }
    d.addEventListener('cancel', onCancel)
    d.addEventListener('close', onClosed)
    return () => {
      d.removeEventListener('cancel', onCancel)
      d.removeEventListener('close', onClosed)
    }
  }, [])

  const titleId = `dlg-${title.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`
  return (
    <dialog ref={ref} className={`modal${wide ? ' modal-wide' : ''}`} aria-labelledby={titleId}>
      {open && (
        <>
          <h2 id={titleId}>{title}</h2>
          {description && <div className="modal-help">{description}</div>}
          {children}
        </>
      )}
    </dialog>
  )
}
