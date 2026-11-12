/** Small stroke icons in the style of Klode/Kopje (24×24, 1.7px strokes). */
const PATHS: Record<string, string[]> = {
  plus: ['M12 5v14M5 12h14'],
  pencil: ['M4 20h4L19 9l-4-4L4 16v4Z', 'm13.5 6.5 4 4'],
  trash: ['M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'],
  download: ['M12 3v12m-5-5 5 5 5-5', 'M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4'],
  reset: ['M4.2 13.7A8 8 0 1 0 6.5 6.2L4 9', 'M4 4v5h5'],
  sidebar: ['M4 5h16v14H4z', 'M9 5v14'],
  play: ['M8 5.5v13l10-6.5-10-6.5Z'],
  stop: ['M7 7h10v10H7z'],
  copy: ['M9 9h10v11H9z', 'M15 9V5a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
  check: ['m5 12.5 4.5 4.5L19 7'],
  key: ['M7.5 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M11.5 12H21', 'M17.5 12v3', 'M20.5 12v2.5'],
  arrow: ['M6 18 18 6', 'M9 6h9v9'],
  'empty-set': ['M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'M5.5 18.5l13-13'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M5 20a7 7 0 0 1 14 0'],
}

export function Icon({ name, size }: { name: keyof typeof PATHS | string; size?: number }) {
  const paths = PATHS[name] ?? []
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width={size} height={size} className="icon">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

/** Run query: a filled play triangle with a small stroked "1" (one statement), as in pgAdmin. */
export function RunQueryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="icon icon-run-query">
      <path d="M2.5 6.4v11.2l8.6-5.6Z" fill="currentColor" stroke="none" />
      <path d="M14.5 13.5l3-2.5v8.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ThemeIcon({ choice }: { choice: 'system' | 'light' | 'dark' }) {
  if (choice === 'light')
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="icon">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </svg>
    )
  if (choice === 'dark')
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="icon">
        <path d="M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11Z" />
      </svg>
    )
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </svg>
  )
}
