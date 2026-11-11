/**
 * Typed request/response protocol between the UI thread and the database worker.
 * Everything crossing the boundary is plain, structured-clone-safe data.
 */

export type TxStatus = 'I' | 'T' | 'E'

export interface PgError {
  severity: string
  code: string
  message: string
  detail?: string
  hint?: string
  /** 1-based character position in the submitted SQL text. */
  position?: string
  internalPosition?: string
  internalQuery?: string
  where?: string
  schema?: string
  table?: string
  column?: string
  dataType?: string
  constraint?: string
}

export interface PgNotice {
  severity: string
  message: string
  detail?: string
  hint?: string
  where?: string
}

export interface ResultColumn {
  name: string
  typeOid: number
  typeMod: number
  /** Resolved via format_type() when possible, e.g. "character varying(50)". */
  typeName: string | null
}

export interface StatementResult {
  /** 1-based index of the statement in the run. */
  index: number
  tag: string
  command: string
  rowCount: number | null
  /** null when the statement returns no row description (DDL, plain DML). */
  columns: ResultColumn[] | null
  /** Text-format values exactly as PostgreSQL sent them; null is SQL NULL. */
  rows: (string | null)[][]
  totalRows: number
  rowsTruncated: boolean
  cellsTruncated: boolean
  /** Output of COPY ... TO STDOUT, if any. */
  copyText: string | null
  copyTruncated: boolean
}

export interface ExecuteOutcome {
  results: StatementResult[]
  statementCount: number
  resultsDropped: number
  error: PgError | null
  /** 1-based index of the statement that failed (as counted by completed statements + 1). */
  errorStatementIndex: number | null
  notices: PgNotice[]
  noticesDropped: number
  txStatus: TxStatus
  /** False if the protocol stream ended without ReadyForQuery. */
  complete: boolean
  durationMs: number
}

export interface SchemaColumn {
  name: string
  type: string
  notNull: boolean
  isPrimaryKey: boolean
  /** e.g. "customers(id)" */
  references: string | null
}

export interface SchemaRelation {
  name: string
  kind: 'table' | 'view' | 'materialized view' | 'partitioned table' | 'foreign table'
  columns: SchemaColumn[]
}

export interface SchemaNamespace {
  name: string
  relations: SchemaRelation[]
}

export interface SchemaInfo {
  /** The database this session is connected to. */
  database: string
  /** Every non-template database of the cluster (the UI decides which to show). */
  allDatabases: string[]
  namespaces: SchemaNamespace[]
}

export interface DbInfo {
  postgresVersion: string
  pgliteVersion: string
  datasetId: string
  /** The database the session is connected to. */
  database: string
  /** Set when the dataset was (re)built now: the databases it touched. Null when reused. */
  databases: string[] | null
  /** True if the database was (re)seeded during this init. */
  seeded: boolean
  /** Set when an existing database was found but carried another dataset marker. */
  datasetMismatch: string | null
  persistent: boolean
}

export type FailureKind = 'cancelled' | 'sql' | 'storage' | 'seed' | 'wasm' | 'crash' | 'internal' | 'unsupported'

export interface WorkerFailure {
  kind: FailureKind
  message: string
  detail?: string
}

// ---- Requests ---------------------------------------------------------------

export interface DatasetSpec {
  id: string
  sql: string
  expectedTables: string[]
}

export type DbRequest =
  | { type: 'init'; dbName: string | null; dataset: DatasetSpec; database: string | null }
  | { type: 'execute'; sql: string; maxRows: number }
  | { type: 'getSchema' }
  | { type: 'createFresh'; dbName: string | null; dataset: DatasetSpec }
  | { type: 'dropDatabase'; dbName: string }
  | { type: 'connect'; database: string }
  | { type: 'close' }
  | { type: 'health' }

export type DbRequestType = DbRequest['type']

export interface DbResponseMap {
  init: DbInfo
  execute: ExecuteOutcome
  getSchema: SchemaInfo
  createFresh: DbInfo
  dropDatabase: { dropped: boolean }
  connect: DbInfo
  close: { closed: true }
  health: { state: 'ready' | 'busy' | 'uninitialized' }
}

export interface RequestEnvelope {
  id: number
  request: DbRequest
}

export type ResponseEnvelope =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; failure: WorkerFailure }
