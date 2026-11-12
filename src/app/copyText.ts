/** Plain-text forms of results for the clipboard. */
import type { StatementResult } from '../db/protocol'
import type { MessageLine } from './describe'

/**
 * Tab-separated, with a header row, as spreadsheets and Word paste it into a
 * table. A value with a tab, newline or double quote is quoted the way Excel
 * does ("…" with "" for a quote); SQL NULL becomes an empty cell. Only the rows
 * Krash received are included.
 */
export function resultAsTsv(r: StatementResult): string {
  const cell = (v: string | null) => (v === null ? '' : /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [(r.columns ?? []).map((c) => cell(c.name)).join('\t'), ...r.rows.map((row) => row.map(cell).join('\t'))]
  return lines.join('\n') + '\n'
}

export function messagesAsText(lines: MessageLine[]): string {
  return lines.map((l) => `${l.label}: ${l.text}`).join('\n') + '\n'
}
