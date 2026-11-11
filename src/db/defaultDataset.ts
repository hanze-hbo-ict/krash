import type { DatasetSpec } from './protocol'
import sql from './default.sql?raw'

/** The database a new workspace starts with, until a .sql file is imported. */
export const DEFAULT_DATASET: DatasetSpec = { id: 'default-v1', sql, expectedTables: ['people'] }
