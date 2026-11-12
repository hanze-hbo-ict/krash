/**
 * Icon button that copies text to the clipboard. For about a second and a half
 * afterwards the icon becomes a checkmark and the tooltip says "Copied" (or
 * "Copy failed"); screen readers hear the same through a live region.
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

interface Props {
  /** Accessible name and tooltip, e.g. "Copy query". */
  label: string
  /** Called on click; returns the text to copy. */
  getText: () => string
  disabled?: boolean
  tooltipPos?: 'end' | 'above-end'
}

type State = 'idle' | 'copied' | 'failed'

export function CopyButton({ label, getText, disabled, tooltipPos }: Props) {
  const [state, setState] = useState<State>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const copy = async () => {
    let next: State = 'copied'
    try {
      await navigator.clipboard.writeText(getText())
    } catch {
      next = 'failed'
    }
    setState(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1500)
  }

  const feedback = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''
  return (
    <>
      <button
        type="button"
        className="icon-button copy-button"
        onClick={() => void copy()}
        disabled={disabled}
        aria-label={label}
        data-tooltip={feedback || label}
        data-tooltip-pos={tooltipPos}
        data-copy-state={state === 'idle' ? undefined : state}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} />
      </button>
      <span className="visually-hidden" role="status">
        {feedback}
      </span>
    </>
  )
}
