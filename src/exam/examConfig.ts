/**
 * Static exam configuration. An exam organiser edits this file (and seed.sql)
 * before building/deploying. There is deliberately no authoring UI.
 *
 * Every value here — and every bundled file — is readable by students.
 */
import seedSql from './seed.sql?raw'

export interface ExamConfig {
  /** Shown in the workspace heading and Help dialog. */
  title: string
  /** Stable identifier written into answer exports. [A-Za-z0-9._-] only. */
  examId: string
  dataset: {
    /** Identifier + version; changing it invalidates persisted databases. */
    id: string
    sql: string
    /** Tables that must exist after seeding, used as a validation check. */
    expectedTables: string[]
  }
  /** Names of the answer tabs created for a fresh workspace. */
  initialTabs: string[]
  features: {
    schemaBrowser: boolean
    /** Click a table to see bounded sample rows. Off by default; check exam rules. */
    tablePreview: boolean
    answerImport: boolean
    answerExport: boolean
  }
  /** Rows kept and shown per statement result. */
  maxRows: number
  /** Optional instructions shown in the Help dialog (plain text). */
  instructions: string | null
}

export const examConfig: ExamConfig = {
  title: 'Databases practice workspace',
  examId: 'dbs-practice',
  dataset: {
    id: 'webshop-v1',
    sql: seedSql,
    expectedTables: ['categories', 'products', 'customers', 'employees', 'orders', 'order_lines', 'reviews'],
  },
  initialTabs: ['Question 1', 'Question 2', 'Question 3'],
  features: {
    schemaBrowser: true,
    tablePreview: false,
    answerImport: true,
    answerExport: true,
  },
  maxRows: 1000,
  instructions: null,
}

export function validateExamConfig(c: ExamConfig): string[] {
  const problems: string[] = []
  if (!c.title.trim()) problems.push('title is empty')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(c.examId)) problems.push('examId must match [A-Za-z0-9._-]{1,64}')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(c.dataset.id)) problems.push('dataset.id must match [A-Za-z0-9._-]{1,64}')
  if (!c.dataset.sql.trim()) problems.push('dataset.sql is empty')
  if (c.initialTabs.length < 1) problems.push('initialTabs needs at least one tab')
  if (c.initialTabs.some((t) => !t.trim())) problems.push('initialTabs contains an empty name')
  if (!Number.isInteger(c.maxRows) || c.maxRows < 1 || c.maxRows > 10_000) problems.push('maxRows must be an integer in 1..10000')
  for (const t of c.dataset.expectedTables) if (!/^[a-z_][a-z0-9_]*$/.test(t)) problems.push(`expectedTables entry "${t}" is not a plain lower-case name`)
  return problems
}
