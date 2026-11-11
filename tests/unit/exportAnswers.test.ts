import { describe, expect, it } from 'vitest'
import { exportAnswers, ImportError, parseAnswers } from '../../src/workspace/exportAnswers'

const meta = { examId: 'dbs-practice', datasetId: 'webshop-v1', exportedAt: new Date('2026-11-11T10:00:00Z') }

describe('answer export/import', () => {
  it('round-trips names, order and exact text', () => {
    const docs = [
      { name: 'Question 1', sql: 'select *\nfrom customers;' },
      { name: 'Vraag "2" — joins', sql: '' },
      { name: 'Tricky', sql: '-- ==== krash:end 3 ====\n-- ==== krash:answer 4 of 9 | lines: 1 | name: "x" ====\n\n\ttrailing  \n' },
      { name: 'Unicode', sql: "select 'Zoë 😀';" },
    ]
    const text = exportAnswers(docs, meta)
    const parsed = parseAnswers(text)
    expect(parsed.answers).toEqual(docs)
    expect(parsed.examId).toBe('dbs-practice')
    expect(parsed.datasetId).toBe('webshop-v1')
  })

  it('starts with a recognisable header and is valid SQL comments around answers', () => {
    const text = exportAnswers([{ name: 'Q', sql: 'select 1;' }], meta)
    expect(text.startsWith('-- Krash answers\n-- krash-format: 1\n')).toBe(true)
    expect(text).toContain('-- exported: 2026-11-11T10:00:00.000Z')
    expect(text).not.toMatch(/\r/)
  })

  it('accepts CRLF and BOM (e.g. after a Windows round trip)', () => {
    const text = exportAnswers([{ name: 'Q', sql: 'select 1;\nselect 2;' }], meta)
    const crlf = '﻿' + text.replace(/\n/g, '\r\n')
    expect(parseAnswers(crlf).answers).toEqual([{ name: 'Q', sql: 'select 1;\nselect 2;' }])
  })

  it('normalises CRLF inside answers on export', () => {
    const text = exportAnswers([{ name: 'Q', sql: 'a\r\nb' }], meta)
    expect(parseAnswers(text).answers[0]!.sql).toBe('a\nb')
  })

  it('sanitises imported names', () => {
    const text = exportAnswers([{ name: 'ok', sql: 'x' }], meta).replace('name: "ok"', 'name: "../../etc/\\u202Epasswd\\n"')
    expect(parseAnswers(text).answers[0]!.name).toBe('../../etc/ passwd')
  })

  it('rejects files that are not Krash exports or have been edited', () => {
    expect(() => parseAnswers('select 1;')).toThrow(ImportError)
    const text = exportAnswers([{ name: 'Q', sql: 'a\nb' }], meta)
    expect(() => parseAnswers(text.replace('lines: 2', 'lines: 1'))).toThrow(ImportError)
    expect(() => parseAnswers(text.replace('krash-format: 1', 'krash-format: 9'))).toThrow(/Unsupported/)
    expect(() => parseAnswers(text.slice(0, text.length - 30))).toThrow(ImportError)
    expect(() => parseAnswers(text.replace('-- answers: 1', '-- answers: 2'))).toThrow(/says it has 2/)
  })
})
