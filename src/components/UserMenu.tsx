/**
 * Footer of the Database pane: the connected user, with a drop-up to connect
 * as another user (like psql's \c - name). Shown only when there is more than
 * one user that can log in.
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

interface Props {
  /** Roles that can log in. */
  users: string[]
  /** The user the session is connected as. */
  current: string
  /** Absent while switching is not possible. */
  onSwitch?: (user: string) => void
}

export function UserMenu({ users, current, onSwitch }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!onSwitch) setOpen(false)
  }, [onSwitch])

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('.user-option[aria-current]')?.focus()
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
      toggle.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const list = users.includes(current) ? users : [current, ...users]
  if (list.length < 2) return null

  return (
    <div
      className="user-menu"
      ref={root}
      onBlur={(e) => {
        // Close when Tab moves focus elsewhere. A null relatedTarget is a mouse
        // press that focuses nothing (Safari and Firefox on macOS do not focus
        // buttons on click): ignore it, or the list would close before the click
        // on a user lands. Clicks outside are handled by the pointerdown listener.
        const next = e.relatedTarget as Node | null
        if (open && next && !root.current?.contains(next)) setOpen(false)
      }}
    >
      {open && (
        <ul className="user-list" id="user-list" aria-label="Connect as user">
          {list.map((u) => (
            <li key={u}>
              <button
                type="button"
                className="user-option"
                aria-current={u === current || undefined}
                onClick={() => {
                  setOpen(false)
                  toggle.current?.focus()
                  if (u !== current) onSwitch?.(u)
                }}
              >
                <span className="tree-name">{u}</span>
                {u === current && <span className="tree-meta">connected</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        ref={toggle}
        className="user-toggle"
        aria-expanded={open}
        aria-controls="user-list"
        aria-label={`User ${current}. Switch user`}
        title="Switch user"
        disabled={!onSwitch}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="user" />
        <span className="user-name">{current}</span>
      </button>
    </div>
  )
}
