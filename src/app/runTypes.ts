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
  status: 'running' | 'done'
  outcome: ExecuteOutcome | null
  failure: WorkerFailure | null
  errorLocation: ErrorLocation | null
}
