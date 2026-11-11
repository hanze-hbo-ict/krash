/**
 * The base dataset: what a fresh or reset database is built from. Either the
 * bundled default dataset, or the last SQL script imported in this tab. An imported
 * script is kept in sessionStorage so Reset and reload can rebuild it.
 */
import type { DatasetSpec } from '../db/protocol'

export const BASE_KEY = 'krash:v1:base'

export interface BaseDataset extends DatasetSpec {
  /** Display name, e.g. "default database". */
  name: string
  imported: boolean
}

export function bundledBase(dataset: DatasetSpec): BaseDataset {
  return { ...dataset, name: 'default database', imported: false }
}

/** Stable id for an imported script (FNV-1a, 32-bit), e.g. "import-1a2b3c4d". */
export function importedDatasetId(sql: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < sql.length; i++) {
    h ^= sql.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `import-${(h >>> 0).toString(16).padStart(8, '0')}`
}

export function importedBase(sql: string): BaseDataset {
  return { id: importedDatasetId(sql), sql, expectedTables: [], name: 'imported database', imported: true }
}

export function loadBase(storage: Storage | null, fallback: BaseDataset): BaseDataset {
  try {
    const raw = storage?.getItem(BASE_KEY)
    if (!raw) return fallback
    const v = JSON.parse(raw) as Partial<BaseDataset>
    if (typeof v.sql !== 'string') return fallback
    return importedBase(v.sql)
  } catch {
    return fallback
  }
}

/** Returns false if the script could not be stored (e.g. quota). */
export function saveBase(storage: Storage | null, base: BaseDataset): boolean {
  try {
    if (!base.imported) storage?.removeItem(BASE_KEY)
    else storage?.setItem(BASE_KEY, JSON.stringify({ sql: base.sql }))
    return !!storage
  } catch {
    return false
  }
}

export function clearBase(storage: Storage | null): void {
  try {
    storage?.removeItem(BASE_KEY)
  } catch {
    /* ignore */
  }
}
