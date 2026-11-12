import { describe, expect, it } from 'vitest'
import { messagesAsText, resultAsTsv } from '../../src/app/copyText'
import type { StatementResult } from '../../src/db/protocol'

const result = (columns: string[], rows: (string | null)[][]): StatementResult => ({
  index: 1,
  tag: 'SELECT',
  command: 'SELECT',
  rowCount: rows.length,
  columns: columns.map((name) => ({ name, typeOid: 25, typeMod: -1, typeName: 'text' })),
  rows,
  totalRows: rows.length,
  rowsTruncated: false,
  cellsTruncated: false,
  copyText: null,
  copyTruncated: false,
})

describe('resultAsTsv', () => {
  it('writes a header row and one line per row, NULL as an empty cell', () => {
    expect(resultAsTsv(result(['id', 'name'], [['1', 'Ada'], ['2', null]]))).toBe('id\tname\n1\tAda\n2\t\n')
  })
  it('quotes values with tabs, newlines or quotes the way Excel does', () => {
    expect(resultAsTsv(result(['v'], [['a\tb'], ['two\nlines'], ['say "hi"'], ['plain']]))).toBe(
      'v\n"a\tb"\n"two\nlines"\n"say ""hi"""\nplain\n',
    )
  })
})

describe('messagesAsText', () => {
  it('writes one line per message', () => {
    expect(messagesAsText([{ level: 'ok', label: '#1', text: 'CREATE TABLE — completed.' }])).toBe('#1: CREATE TABLE — completed.\n')
  })
})
