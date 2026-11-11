import type { ExecuteOutcome, WorkerFailure } from '../db/protocol'

export interface ErrorLocation {
  /** Offset in the answer document (not only the selection). */
  offset: number
  line: number
  col: number
  /** A short excerpt of the line, for orientation. */
  text: string
}

export interface RunRecord {
  id: number
  kind: 'query' | 'preview'
  docId: string
  docName: string
  isSelection: boolean
  /** 1-based line range of the executed text within the document. */
  lines: { from: number; to: number }
  startedAt: number
  status: 'running' | 'done'
  outcome: ExecuteOutcome | null
  failure: WorkerFailure | null
  errorLocation: ErrorLocation | null
}
