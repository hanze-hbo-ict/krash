/** Plain-text descriptions of run outcomes (for the Messages view and status). */
import type { ExecuteOutcome, StatementResult } from '../db/protocol'
import type { RunRecord } from './runTypes'

// int2, int4, int8, oid, float4, float8, numeric, money
export const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700])

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`

export function describeStatement(r: StatementResult): string {
  const cmd = r.command
  if (r.copyText !== null) return `COPY output${r.rowCount !== null ? ` (${plural(r.rowCount, 'row')})` : ''}.`
  if (r.columns !== null) {
    if (cmd === 'SELECT' || cmd === 'SHOW' || cmd === 'EXPLAIN' || cmd === 'VALUES' || cmd === 'TABLE' || cmd === 'FETCH') {
      return `${plural(r.totalRows, 'row')}.`
    }
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

export function describeOutcome(run: RunRecord, o: ExecuteOutcome): MessageLine[] {
  const out: MessageLine[] = []
  const where = run.isSelection
    ? `selected text (lines ${run.lines.from}–${run.lines.to}) of “${run.docName}”`
    : `“${run.docName}”`
  out.push({
    level: 'info',
    label: 'Run',
    text: `${run.kind === 'preview' ? 'Sample rows' : where} at ${new Date(run.startedAt).toLocaleTimeString('en-GB')}, ${o.durationMs} ms.`,
  })
  if (o.statementCount === 0 && !o.error) out.push({ level: 'info', label: 'Empty', text: 'There was no SQL statement to run.' })
  for (const r of o.results) out.push({ level: 'ok', label: `#${r.index}`, text: describeStatement(r) })
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
  out.push({ level: 'info', label: 'Session', text: txText(o.txStatus) })
  return out
}

export function txText(s: ExecuteOutcome['txStatus']): string {
  if (s === 'T') return 'A transaction is open (BEGIN without COMMIT/ROLLBACK yet).'
  if (s === 'E') return 'The open transaction has failed. Run ROLLBACK to continue.'
  return 'No open transaction.'
}
