/** Answer-tab names are display labels only: never paths, never markup. */
export const MAX_NAME_LENGTH = 60

export function sanitizeName(raw: string): string {
  // Drop control/format characters (incl. bidi overrides), collapse whitespace.
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('')
}

/** Returns a unique, sanitized name, appending " (2)", " (3)", … when needed. */
export function uniqueName(raw: string, taken: Iterable<string>, fallback = 'Answer'): string {
  const base = sanitizeName(raw) || fallback
  const set = new Set([...taken].map((t) => t.toLowerCase()))
  if (!set.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`
    const candidate = Array.from(base).slice(0, MAX_NAME_LENGTH - suffix.length).join('') + suffix
    if (!set.has(candidate.toLowerCase())) return candidate
  }
}

/** Next free "Query N" name. */
export function nextTabName(taken: Iterable<string>): string {
  const names = new Set([...taken].map((t) => t.toLowerCase()))
  for (let i = 1; ; i++) if (!names.has(`query ${i}`)) return `Query ${i}`
}

/** Safe download filename: ASCII letters, digits, dot, dash, underscore. */
export function safeFileName(raw: string, fallback = 'krash-answers'): string {
  const base = raw
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return base || fallback
}
