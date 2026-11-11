/**
 * A deliberately tiny PostgreSQL *lexer* used for exactly one safety check:
 * detecting `COPY ... FROM STDIN`, which hangs/aborts the embedded PGlite
 * engine (there is no client to stream data from).
 *
 * It does NOT split statements for execution — the whole script is always sent
 * to PostgreSQL unchanged. It only needs to know which words are real keywords
 * (not inside strings, quoted identifiers, comments or dollar-quoted bodies).
 */

export interface Word {
  text: string
  start: number
}

/** Yields top-level statements as lists of bare words. */
export function lexWords(sql: string): Word[][] {
  const statements: Word[][] = [[]]
  const n = sql.length
  let i = 0
  const cur = () => statements[statements.length - 1]!
  while (i < n) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
    } else if (ch === '/' && next === '*') {
      // Nested block comments, as in PostgreSQL.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
    } else if (ch === "'") {
      // Standard string; E'' strings allow backslash escapes.
      const prev = sql[i - 1]
      const escapes = (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? '')
      i++
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2
        else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2
          else {
            i++
            break
          }
        } else i++
      }
    } else if (ch === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2
          else {
            i++
            break
          }
        } else i++
      }
    } else if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      const prev = sql[i - 1] ?? ''
      if (m && !/[A-Za-z0-9_]/.test(prev)) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        i = close < 0 ? n : close + tag.length
      } else i++
    } else if (ch === ';') {
      statements.push([])
      i++
    } else if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i]!)) i++
      cur().push({ text: sql.slice(start, i).toLowerCase(), start })
    } else i++
  }
  return statements.filter((s) => s.length > 0)
}

/** Returns the offset of a `COPY ... FROM STDIN` statement, or null. */
export function findCopyFromStdin(sql: string): number | null {
  for (const words of lexWords(sql)) {
    if (words[0]?.text !== 'copy') continue
    for (let k = 1; k < words.length; k++) {
      if (words[k]!.text === 'stdin' && words[k - 1]!.text === 'from') return words[0]!.start
    }
  }
  return null
}

/**
 * Convert PostgreSQL's 1-based *character* position into a 0-based JS string
 * offset (PostgreSQL counts code points; JS strings count UTF-16 units).
 */
export function pgPositionToOffset(sql: string, position: number): number {
  let offset = 0
  let chars = 1
  while (offset < sql.length && chars < position) {
    const code = sql.codePointAt(offset)!
    offset += code > 0xffff ? 2 : 1
    chars++
  }
  return offset
}

export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1
  let lineStart = 0
  const end = Math.min(offset, text.length)
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: end - lineStart + 1 }
}
