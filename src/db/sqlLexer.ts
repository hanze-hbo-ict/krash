/**
 * A deliberately tiny PostgreSQL *lexer*. It knows which words are real keywords
 * (not inside strings, quoted identifiers, comments or dollar-quoted bodies) and
 * where top-level statements end. It is used for two things only:
 *  - refusing `COPY ... FROM STDIN`, which hangs/aborts the embedded engine;
 *  - splitting an imported script at its `CREATE DATABASE` statements, so each
 *    section can run connected to its own database (like psql's `\c`).
 * A Run from the editor is always sent to PostgreSQL unchanged, as one script.
 */

export interface Word {
  text: string
  start: number
}

export interface Statement {
  words: Word[]
  /** Offset of the statement's first character (just after the previous `;`). */
  start: number
  /** Offset just after the terminating `;` (or the end of the text). */
  end: number
}

/** Yields top-level statements as lists of bare words. */
export function lexWords(sql: string): Word[][] {
  return lexStatements(sql)
    .map((s) => s.words)
    .filter((w) => w.length > 0)
}

/** Top-level statements with their text range; includes empty/comment-only ones. */
export function lexStatements(sql: string): Statement[] {
  const statements: Statement[] = [{ words: [], start: 0, end: sql.length }]
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
      cur().end = i + 1
      statements.push({ words: [], start: i + 1, end: n })
      i++
    } else if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i]!)) i++
      cur().words.push({ text: sql.slice(start, i).toLowerCase(), start })
    } else i++
  }
  return statements
}

export interface ScriptSection {
  /** The `CREATE DATABASE …;` statement that starts this section; null for the part before the first one. */
  createDatabase: string | null
  /** The statements that follow, up to the next `CREATE DATABASE`, as written. */
  body: string
  /** False if the body contains no statements (only whitespace or comments). */
  hasStatements: boolean
}

/**
 * Splits an imported script at top-level `CREATE DATABASE` statements.
 * The first section is what comes before the first `CREATE DATABASE` (it runs
 * in the `postgres` database); every following section runs in the database
 * its statement created.
 */
export function splitByCreateDatabase(sql: string): ScriptSection[] {
  const sections: ScriptSection[] = []
  let current: { createDatabase: string | null; bodyStart: number; hasStatements: boolean } = {
    createDatabase: null,
    bodyStart: 0,
    hasStatements: false,
  }
  const close = (bodyEnd: number) =>
    sections.push({ createDatabase: current.createDatabase, body: sql.slice(current.bodyStart, bodyEnd), hasStatements: current.hasStatements })
  for (const st of lexStatements(sql)) {
    if (st.words[0]?.text === 'create' && st.words[1]?.text === 'database') {
      close(st.words[0].start)
      current = { createDatabase: sql.slice(st.words[0].start, st.end), bodyStart: st.end, hasStatements: false }
    } else if (st.words.length > 0) {
      current.hasStatements = true
    }
  }
  close(sql.length)
  return sections
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
