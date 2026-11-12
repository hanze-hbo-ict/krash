import type { ExecuteOutcome, WorkerFailure } from '../db/protocol'

export interface ErrorLocation {
  /** Offset in the editor text (not only the selection). */
  offset: number
  line: number
  col: number
  /** A short excerpt of the line, for orientation. */
  text: string
}

export interface RunRecord {
  id: number
  /** What was run: the selected text, the statement at the cursor, or the whole editor. */
  scope: 'selection' | 'statement' | 'all'
  /** 1-based line range of the executed text within the document. */
  lines: { from: number; to: number }
  startedAt: number
  status: 'running' | 'done'
  outcome: ExecuteOutcome | null
  failure: WorkerFailure | null
  errorLocation: ErrorLocation | null
}
