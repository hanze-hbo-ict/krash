/**
 * Minimal, streaming reader for the PostgreSQL v3 backend protocol.
 *
 * PGlite streams raw protocol bytes for a simple-query message in ~8 KB chunks
 * (`execProtocolRawStream`). We decode them here instead of using `exec()`
 * because:
 *  - `exec()` materialises every row as JS objects (no way to bound huge results);
 *  - `exec()` throws on the first error and drops results of statements that
 *    already completed, so partial execution could not be reported honestly;
 *  - we want values exactly as PostgreSQL formats them in text mode (like psql),
 *    not re-interpreted JS Dates/numbers.
 *
 * Rows past `maxRows` are counted but never decoded.
 */

import type { ExecuteOutcome, PgError, PgNotice, StatementResult, TxStatus } from './protocol'

export interface WireLimits {
  /** Max rows kept per statement result. */
  maxRows: number
  /** Max characters kept per cell value. */
  maxCellChars: number
  /** Max statement results kept per run (later ones are counted only). */
  maxResults: number
  /** Max characters of COPY ... TO STDOUT output kept per statement. */
  maxCopyChars: number
  /** Max notices kept per run. */
  maxNotices: number
}

export const DEFAULT_LIMITS: WireLimits = {
  maxRows: 1000,
  maxCellChars: 10_000,
  maxResults: 50,
  maxCopyChars: 100_000,
  maxNotices: 200,
}

const decoder = new TextDecoder('utf-8', { fatal: false })

interface PendingStatement {
  columns: { name: string; typeOid: number; typeMod: number }[] | null
  rows: (string | null)[][]
  totalRows: number
  truncatedCells: boolean
  copyText: string | null
  copyTruncated: boolean
}

function newPending(): PendingStatement {
  return { columns: null, rows: [], totalRows: 0, truncatedCells: false, copyText: null, copyTruncated: false }
}

/** Parse "INSERT 0 3" / "SELECT 2" / "CREATE TABLE" command tags. */
export function parseCommandTag(tag: string): { command: string; rowCount: number | null } {
  const parts = tag.trim().split(/\s+/)
  const last = parts[parts.length - 1] ?? ''
  if (parts.length > 1 && /^\d+$/.test(last)) {
    let words = parts.slice(0, -1)
    // INSERT has the form "INSERT oid rows"
    if (words[0] === 'INSERT' && words.length === 2) words = ['INSERT']
    return { command: words.join(' '), rowCount: Number(last) }
  }
  return { command: tag.trim(), rowCount: null }
}

const ERROR_FIELDS: Record<string, keyof PgError> = {
  S: 'severity',
  V: 'severity',
  C: 'code',
  M: 'message',
  D: 'detail',
  H: 'hint',
  P: 'position',
  p: 'internalPosition',
  q: 'internalQuery',
  W: 'where',
  s: 'schema',
  t: 'table',
  c: 'column',
  d: 'dataType',
  n: 'constraint',
}

export class WireReader {
  private buf: Uint8Array = new Uint8Array(0)
  private pending: PendingStatement = newPending()
  private results: StatementResult[] = []
  private statementCount = 0
  private notices: PgNotice[] = []
  private noticesDropped = 0
  private error: PgError | null = null
  private errorStatementIndex: number | null = null
  private txStatus: TxStatus = 'I'
  private sawReady = false

  constructor(private readonly limits: WireLimits = DEFAULT_LIMITS) {}

  push(chunk: Uint8Array): void {
    let data: Uint8Array
    if (this.buf.length === 0) {
      data = chunk
    } else {
      data = new Uint8Array(this.buf.length + chunk.length)
      data.set(this.buf, 0)
      data.set(chunk, this.buf.length)
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    let off = 0
    while (data.length - off >= 5) {
      const type = data[off]!
      const len = view.getInt32(off + 1)
      if (len < 4) throw new Error(`Malformed protocol message (length ${len})`)
      const end = off + 1 + len
      if (end > data.length) break
      this.handle(type, data, view, off + 5, end)
      off = end
    }
    // Keep only the unconsumed tail (copy so we don't pin a large chunk).
    this.buf = off === data.length ? new Uint8Array(0) : data.slice(off)
  }

  private readCString(data: Uint8Array, start: number, end: number): [string, number] {
    let i = start
    while (i < end && data[i] !== 0) i++
    return [decoder.decode(data.subarray(start, i)), i + 1]
  }

  private handle(type: number, data: Uint8Array, view: DataView, start: number, end: number): void {
    switch (String.fromCharCode(type)) {
      case 'T': {
        const n = view.getInt16(start)
        let p = start + 2
        const cols: { name: string; typeOid: number; typeMod: number }[] = []
        for (let i = 0; i < n; i++) {
          const [name, next] = this.readCString(data, p, end)
          p = next
          // tableOid int32, attnum int16, typeOid int32, typlen int16, typmod int32, format int16
          const typeOid = view.getUint32(p + 6)
          const typeMod = view.getInt32(p + 12)
          p += 18
          cols.push({ name, typeOid, typeMod })
        }
        this.pending.columns = cols
        break
      }
      case 'D': {
        this.pending.totalRows++
        if (this.pending.rows.length >= this.limits.maxRows || this.results.length >= this.limits.maxResults) break
        const n = view.getInt16(start)
        let p = start + 2
        const row: (string | null)[] = []
        for (let i = 0; i < n; i++) {
          const len = view.getInt32(p)
          p += 4
          if (len < 0) {
            row.push(null)
          } else {
            // Decode at most ~4 bytes per allowed char to bound work on giant values.
            const take = Math.min(len, this.limits.maxCellChars * 4)
            let s = decoder.decode(data.subarray(p, p + take))
            if (take < len || s.length > this.limits.maxCellChars) {
              s = s.slice(0, this.limits.maxCellChars)
              this.pending.truncatedCells = true
            }
            row.push(s)
            p += len
          }
        }
        this.pending.rows.push(row)
        break
      }
      case 'C': {
        const [tag] = this.readCString(data, start, end)
        this.finishStatement(tag)
        break
      }
      case 'I': // EmptyQueryResponse: the whole query was empty / only comments
        break
      case 'E':
      case 'N': {
        const fields: Partial<Record<keyof PgError, string>> = {}
        let p = start
        while (p < end && data[p] !== 0) {
          const code = String.fromCharCode(data[p]!)
          const [value, next] = this.readCString(data, p + 1, end)
          p = next
          const key = ERROR_FIELDS[code]
          // Prefer the non-localized severity (V) when present.
          if (key && !(key === 'severity' && code === 'S' && fields.severity)) fields[key] = value
        }
        if (type === 0x45 /* E */) {
          this.error = {
            severity: fields.severity ?? 'ERROR',
            code: fields.code ?? '',
            message: fields.message ?? 'Unknown error',
            detail: fields.detail,
            hint: fields.hint,
            position: fields.position,
            internalPosition: fields.internalPosition,
            internalQuery: fields.internalQuery,
            where: fields.where,
            schema: fields.schema,
            table: fields.table,
            column: fields.column,
            dataType: fields.dataType,
            constraint: fields.constraint,
          }
          this.errorStatementIndex = this.statementCount + 1
          // Discard anything collected for the failed statement.
          this.pending = newPending()
        } else {
          this.pushNotice({
            severity: fields.severity ?? 'NOTICE',
            message: fields.message ?? '',
            detail: fields.detail,
            hint: fields.hint,
            where: fields.where,
          })
        }
        break
      }
      case 'A': {
        // NotificationResponse: int32 pid, channel, payload
        const [channel, next] = this.readCString(data, start + 4, end)
        const [payload] = this.readCString(data, next, end)
        this.pushNotice({ severity: 'NOTIFY', message: `Asynchronous notification "${channel}" received: ${payload}` })
        break
      }
      case 'H': // CopyOutResponse
        this.pending.copyText = ''
        break
      case 'd': {
        // CopyData
        if (this.pending.copyText === null) this.pending.copyText = ''
        const remaining = this.limits.maxCopyChars - this.pending.copyText.length
        if (remaining > 0) {
          const text = decoder.decode(data.subarray(start, end))
          this.pending.copyText += text.slice(0, remaining)
          if (text.length > remaining) this.pending.copyTruncated = true
        } else {
          this.pending.copyTruncated = true
        }
        break
      }
      case 'Z':
        this.txStatus = (String.fromCharCode(data[start]!) as TxStatus) ?? 'I'
        this.sawReady = true
        break
      default:
        // ParameterStatus (S), CopyDone (c), BackendKeyData (K), etc. are not shown.
        break
    }
  }

  private pushNotice(n: PgNotice): void {
    if (this.notices.length < this.limits.maxNotices) this.notices.push(n)
    else this.noticesDropped++
  }

  private finishStatement(tag: string): void {
    this.statementCount++
    const p = this.pending
    this.pending = newPending()
    if (this.results.length >= this.limits.maxResults) return
    const { command, rowCount } = parseCommandTag(tag)
    this.results.push({
      index: this.statementCount,
      tag,
      command,
      rowCount,
      columns: p.columns ? p.columns.map((c) => ({ name: c.name, typeOid: c.typeOid, typeMod: c.typeMod, typeName: null })) : null,
      rows: p.rows,
      totalRows: p.totalRows,
      rowsTruncated: p.totalRows > p.rows.length,
      cellsTruncated: p.truncatedCells,
      copyText: p.copyText,
      copyTruncated: p.copyTruncated,
    })
  }

  finish(durationMs: number): ExecuteOutcome {
    return {
      results: this.results,
      statementCount: this.statementCount,
      resultsDropped: Math.max(0, this.statementCount - this.results.length),
      error: this.error,
      errorStatementIndex: this.errorStatementIndex,
      notices: this.notices,
      noticesDropped: this.noticesDropped,
      txStatus: this.txStatus,
      complete: this.sawReady,
      durationMs,
    }
  }
}
