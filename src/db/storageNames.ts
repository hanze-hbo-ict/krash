/**
 * Naming of per-session PGlite databases in IndexedDB.
 *
 * Each browser tab session gets its own database: `krash-<sessionId>-<generation>`.
 * A database reset creates the next generation and swaps to it once seeded, so a
 * failed reset never leaves the tab without its previous database.
 */
export const DB_PREFIX = 'krash-'

/** PGlite's IdbFs stores `idb://<name>` in the IndexedDB database `/pglite/<name>`. */
export function idbNameFor(dbName: string): string {
  return `/pglite/${dbName}`
}

export function dbNameFor(sessionId: string, generation: number): string {
  return `${DB_PREFIX}${sessionId}-${generation}`
}

export function parseDbName(name: string): { sessionId: string; generation: number } | null {
  const m = /^krash-([a-z0-9]{8,40})-(\d{1,6})$/.exec(name)
  return m ? { sessionId: m[1]!, generation: Number(m[2]) } : null
}

/** Maps an IndexedDB database name back to a Krash db name, if it is one. */
export function dbNameFromIdb(idbName: string): string | null {
  if (!idbName.startsWith('/pglite/')) return null
  const name = idbName.slice('/pglite/'.length)
  return parseDbName(name) ? name : null
}
