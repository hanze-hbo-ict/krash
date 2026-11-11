/**
 * Krash answer export format, version 1.
 *
 *   -- Krash answers
 *   -- krash-format: 1
 *   -- exam: dbs-practice
 *   -- dataset: webshop-v1
 *   -- exported: 2026-11-11T10:00:00.000Z
 *   -- answers: 2
 *
 *   -- ==== krash:answer 1 of 2 | lines: 3 | name: "Question 1" ====
 *   select *
 *   from customers;
 *
 *   -- ==== krash:end 1 ====
 *
 * The file is valid SQL (separators are comments) but is meant to be read by
 * people and re-imported by Krash, not executed as a whole.
 *
 * Every answer block states its exact line count, so the importer never has to
 * guess where an answer ends: student code that happens to contain a line
 * looking like a separator is still restored exactly. The name is a JSON
 * string literal, so quotes and other characters survive unambiguously.
 */
import type { AnswerDoc } from './types'
import { sanitizeName } from './names'

export const EXPORT_FORMAT_VERSION = 1

export interface ExportMeta {
  examId: string
  datasetId: string
  exportedAt: Date
}

export interface ImportedAnswer {
  name: string
  sql: string
}

export interface ImportResult {
  answers: ImportedAnswer[]
  examId: string | null
  datasetId: string | null
}

export class ImportError extends Error {}

function countLines(text: string): number {
  return text.split('\n').length
}

export function exportAnswers(docs: Pick<AnswerDoc, 'name' | 'sql'>[], meta: ExportMeta): string {
  const out: string[] = [
    '-- Krash answers',
    `-- krash-format: ${EXPORT_FORMAT_VERSION}`,
    `-- exam: ${oneLine(meta.examId)}`,
    `-- dataset: ${oneLine(meta.datasetId)}`,
    `-- exported: ${meta.exportedAt.toISOString()}`,
    `-- answers: ${docs.length}`,
    '--',
    '-- Downloading this file is not the same as submitting it.',
    '-- Upload it via your exam platform.',
    '',
  ]
  docs.forEach((doc, i) => {
    const sql = normalizeNewlines(doc.sql)
    const n = i + 1
    out.push(`-- ==== krash:answer ${n} of ${docs.length} | lines: ${countLines(sql)} | name: ${JSON.stringify(sanitizeName(doc.name))} ====`)
    out.push(sql)
    out.push(`-- ==== krash:end ${n} ====`)
    out.push('')
  })
  return out.join('\n')
}

/** Plain text of one answer, for "Copy answer". */
export function answerAsText(doc: Pick<AnswerDoc, 'sql'>): string {
  return normalizeNewlines(doc.sql)
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

const HEADER_RE = /^-- ==== krash:answer (\d+) of (\d+) \| lines: (\d+) \| name: (".*") ====$/
const END_RE = /^-- ==== krash:end (\d+) ====$/

export function parseAnswers(text: string): ImportResult {
  // Strip a UTF-8 BOM and normalise line endings (e.g. after a Windows round trip).
  const lines = normalizeNewlines(text.replace(/^﻿/, '')).split('\n')
  if (lines[0]?.trim() !== '-- Krash answers') {
    throw new ImportError('This is not a Krash answer export (the first line should be "-- Krash answers").')
  }
  let examId: string | null = null
  let datasetId: string | null = null
  let declared: number | null = null
  let format: number | null = null
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('-- ==== krash:answer')) break
    const m = /^-- ([a-z-]+): (.*)$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (key === 'krash-format') format = Number(value)
    else if (key === 'exam') examId = value!.trim()
    else if (key === 'dataset') datasetId = value!.trim()
    else if (key === 'answers') declared = Number(value)
  }
  if (format === null) throw new ImportError('The export has no "krash-format" line.')
  if (format !== EXPORT_FORMAT_VERSION) {
    throw new ImportError(`Unsupported export format version ${format}; this Krash reads version ${EXPORT_FORMAT_VERSION}.`)
  }
  const answers: ImportedAnswer[] = []
  while (i < lines.length) {
    const line = lines[i]!
    if (line === '') {
      i++
      continue
    }
    const h = HEADER_RE.exec(line)
    if (!h) throw new ImportError(`Unexpected text on line ${i + 1}; the file may have been edited.`)
    const n = Number(h[1])
    const count = Number(h[3])
    let name: unknown
    try {
      name = JSON.parse(h[4]!)
    } catch {
      throw new ImportError(`The name of answer ${n} is malformed (line ${i + 1}).`)
    }
    if (typeof name !== 'string') throw new ImportError(`The name of answer ${n} is malformed (line ${i + 1}).`)
    if (n !== answers.length + 1) throw new ImportError(`Answers are out of order near line ${i + 1}.`)
    const body = lines.slice(i + 1, i + 1 + count)
    if (body.length !== count) throw new ImportError(`Answer ${n} is incomplete; the file may be truncated.`)
    const endLine = lines[i + 1 + count]
    const e = endLine === undefined ? null : END_RE.exec(endLine)
    if (!e || Number(e[1]) !== n) {
      throw new ImportError(`Answer ${n} does not end where expected (line ${i + 2 + count}); the file may have been edited.`)
    }
    answers.push({ name: sanitizeName(name), sql: body.join('\n') })
    i += count + 2
  }
  if (declared !== null && declared !== answers.length) {
    throw new ImportError(`The export says it has ${declared} answers but contains ${answers.length}.`)
  }
  return { answers, examId, datasetId }
}
