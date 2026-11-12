/** Plain-text descriptions of run outcomes (for the Messages view and status). */
import type { ExecuteOutcome, StatementResult } from '../db/protocol'

// int2, int4, int8, oid, float4, float8, numeric, money
export const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700])

/**
 * PostgreSQL's long type names in their usual short form: varchar(50), char(3),
 * timestamp(3), timestamptz, time, timetz (also for arrays).
 */
export function shortType(type: string): string {
  return type
    .replace(/\bcharacter varying\b/g, 'varchar')
    .replace(/\bcharacter\b/g, 'char')
    .replace(/\b(timestamp|time)(\(\d+\))? without time zone\b/g, '$1$2')
    .replace(/\b(timestamp|time)(\(\d+\))? with time zone\b/g, '$1tz$2')
}

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`

const QUERY_COMMANDS = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'VALUES', 'TABLE', 'FETCH'])

/** A statement whose only outcome is its rows: its result tab already shows the row count. */
function onlyReturnsRows(r: StatementResult): boolean {
  return r.columns !== null && r.copyText === null && QUERY_COMMANDS.has(r.command)
}

export function describeStatement(r: StatementResult): string {
  const cmd = r.command
  if (r.copyText !== null) return `COPY output${r.rowCount !== null ? ` (${plural(r.rowCount, 'row')})` : ''}.`
  if (r.columns !== null) {
    if (QUERY_COMMANDS.has(cmd)) return `${plural(r.totalRows, 'row')}.`
    // e.g. INSERT ... RETURNING
    return `${cmd}: ${plural(r.rowCount ?? r.totalRows, 'row')} affected, ${plural(r.totalRows, 'row')} returned.`
  }
  if (r.rowCount !== null && /^(INSERT|UPDATE|DELETE|MERGE|COPY|MOVE)$/.test(cmd)) return `${cmd}: ${plural(r.rowCount, 'row')} affected.`
  if (r.rowCount !== null && cmd === 'SELECT') return `SELECT INTO: ${plural(r.rowCount, 'row')}.`
  return `${r.tag} — completed.`
}

export interface MessageLine {
  level: 'info' | 'ok' | 'notice' | 'error' | 'warn'
  label: string
  text: string
}

export function describeOutcome(o: ExecuteOutcome): MessageLine[] {
  const out: MessageLine[] = []
  if (o.statementCount === 0 && !o.error) out.push({ level: 'info', label: 'Empty', text: 'There was no SQL statement to run.' })
  for (const r of o.results) if (!onlyReturnsRows(r)) out.push({ level: 'ok', label: `#${r.index}`, text: describeStatement(r) })
  if (o.resultsDropped > 0)
    out.push({ level: 'warn', label: 'Limit', text: `${plural(o.resultsDropped, 'more statement')} completed; their results are not shown.` })
  for (const n of o.notices) {
    const extra = [n.detail && `DETAIL: ${n.detail}`, n.hint && `HINT: ${n.hint}`].filter(Boolean).join(' ')
    out.push({ level: 'notice', label: n.severity, text: extra ? `${n.message} ${extra}` : n.message })
  }
  if (o.noticesDropped > 0) out.push({ level: 'warn', label: 'Limit', text: `${plural(o.noticesDropped, 'more notice')} not shown.` })
  if (o.error) {
    const label = o.error.code === 'KRASH' ? 'Not run' : o.error.severity
    out.push({ level: 'error', label, text: `${o.errorStatementIndex && o.statementCount > 0 ? `#${o.errorStatementIndex}: ` : ''}${o.error.message}` })
  }
  // Only worth a line when a transaction is still open or has failed.
  if (o.txStatus !== 'I') out.push({ level: o.txStatus === 'E' ? 'warn' : 'info', label: 'Session', text: txText(o.txStatus) })
  return out
}

export function txText(s: ExecuteOutcome['txStatus']): string {
  if (s === 'T') return 'A transaction is open (BEGIN without COMMIT/ROLLBACK yet).'
  if (s === 'E') return 'The open transaction has failed. Run ROLLBACK to continue.'
  return 'No open transaction.'
}
