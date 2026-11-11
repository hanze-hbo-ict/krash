/**
 * Horizontal splitter between editor and results. Usable without dragging:
 * focus it and use ↑/↓ (or Home/End).
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

interface Props {
  fraction: number
  onChange: (fraction: number) => void
  /** The element whose height is being split. */
  containerRef: React.RefObject<HTMLElement>
  min?: number
  max?: number
}

export function Splitter({ fraction, onChange, containerRef, min = 0.2, max = 0.8 }: Props) {
  const dragging = useRef(false)
  const clamp = (f: number) => Math.min(max, Math.max(min, f))

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.05
    let f: number | null = null
    if (e.key === 'ArrowUp') f = fraction - step
    else if (e.key === 'ArrowDown') f = fraction + step
    else if (e.key === 'Home') f = min
    else if (e.key === 'End') f = max
    if (f === null) return
    e.preventDefault()
    onChange(Math.round(clamp(f) * 100) / 100)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    if (rect.height <= 0) return
    onChange(Math.round(clamp((e.clientY - rect.top) / rect.height) * 100) / 100)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor and results"
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={`Editor ${Math.round(fraction * 100)}% of the height`}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="splitter-grip" aria-hidden="true" />
    </div>
  )
}
