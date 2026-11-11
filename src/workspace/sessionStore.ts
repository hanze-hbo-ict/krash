/**
 * Session-scoped persistence of the workspace.
 *
 * - The query text and UI preferences live in sessionStorage: they survive a
 *   reload of the same browser tab, not a closed tab.
 * - The database lives in IndexedDB under a per-session name (see storageNames).
 *   IndexedDB is durable storage, so we keep a heartbeat in localStorage and
 *   delete databases of sessions that have been silent for a long time.
 */
import type { UiPrefs, Workspace } from './types'
import { randomId } from './ids'
import { dbNameFor, parseDbName } from '../db/storageNames'

export const WORKSPACE_KEY = 'krash:v1:workspace'
export const HEARTBEAT_PREFIX = 'krash:v1:alive:'
/** A session whose tab has not been seen for this long is considered abandoned. */
export const ORPHAN_AFTER_MS = 12 * 60 * 60 * 1000
export const HEARTBEAT_INTERVAL_MS = 60 * 1000
export const MAX_SQL_LENGTH = 1_000_000

export const DEFAULT_UI: UiPrefs = { sidebarCollapsed: false, editorFraction: 0.55, theme: 'system' }

export function safeStorage(kind: 'session' | 'local'): Storage | null {
  try {
    const s = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage
    if (!s) return null
    const probe = `krash:probe:${randomId(6)}`
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return null
  }
}

export function createWorkspace(persistent: boolean, ui: UiPrefs = DEFAULT_UI): Workspace {
  const sessionId = randomId(16)
  return {
    version: 1,
    sessionId,
    dbName: persistent ? dbNameFor(sessionId, 1) : null,
    generation: 1,
    sql: '',
    database: 'postgres',
    databases: ['postgres'],
    ui: { ...ui },
  }
}

/** PostgreSQL identifiers are at most 63 bytes; anything else is not a database name we wrote. */
function isDbName(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && new TextEncoder().encode(v).length <= 63
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validates untrusted JSON from storage. Returns null if unusable. */
export function parseWorkspace(raw: string | null): Workspace | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(v) || v.version !== 1) return null
  if (typeof v.sessionId !== 'string' || !/^[a-z0-9]{8,40}$/.test(v.sessionId)) return null
  let sql: string
  if (typeof v.sql === 'string') sql = v.sql
  else if (Array.isArray(v.docs)) {
    // Earlier versions had several query tabs: keep the active one.
    const docs = v.docs.filter((d): d is Record<string, unknown> => isObj(d) && typeof d.sql === 'string')
    const active = docs.find((d) => d.id === v.activeId) ?? docs[0]
    sql = typeof active?.sql === 'string' ? active.sql : ''
  } else return null
  const generation = typeof v.generation === 'number' && Number.isInteger(v.generation) && v.generation > 0 ? v.generation : 1
  let dbName: string | null = null
  if (typeof v.dbName === 'string') {
    const parsed = parseDbName(v.dbName)
    if (!parsed || parsed.sessionId !== v.sessionId) return null
    dbName = v.dbName
  }
  const ui = isObj(v.ui) ? v.ui : {}
  return {
    version: 1,
    sessionId: v.sessionId,
    dbName,
    generation,
    sql: sql.slice(0, MAX_SQL_LENGTH),
    database: typeof v.database === 'string' && isDbName(v.database) ? v.database : 'postgres',
    databases: Array.isArray(v.databases) && v.databases.every(isDbName) && v.databases.length > 0 ? (v.databases as string[]).slice(0, 100) : ['postgres'],
    ui: {
      sidebarCollapsed: typeof ui.sidebarCollapsed === 'boolean' ? ui.sidebarCollapsed : DEFAULT_UI.sidebarCollapsed,
      editorFraction:
        typeof ui.editorFraction === 'number' && ui.editorFraction >= 0.2 && ui.editorFraction <= 0.8
          ? ui.editorFraction
          : DEFAULT_UI.editorFraction,
      theme: ui.theme === 'light' || ui.theme === 'dark' || ui.theme === 'system' ? ui.theme : DEFAULT_UI.theme,
    },
  }
}

export function loadWorkspace(storage: Storage | null): Workspace | null {
  if (!storage) return null
  try {
    return parseWorkspace(storage.getItem(WORKSPACE_KEY))
  } catch {
    return null
  }
}

export type SaveState = 'saved' | 'saving' | 'failed' | 'unavailable'

/**
 * Debounced writer. Reports state transitions so the UI can show
 * "Saved locally" / "Saving…" / "Save failed".
 */
export class WorkspaceSaver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latest: Workspace | null = null

  constructor(
    private readonly storage: Storage | null,
    private readonly onState: (state: SaveState, error?: string) => void,
    private readonly delayMs = 400,
  ) {
    if (!storage) onState('unavailable')
  }

  schedule(ws: Workspace): void {
    this.latest = ws
    if (!this.storage) return
    this.onState('saving')
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  /** Write immediately (also used on pagehide, best effort). */
  flush(): boolean {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.storage || !this.latest) return false
    try {
      const json = JSON.stringify(this.latest)
      this.storage.setItem(WORKSPACE_KEY, json)
      // Read back to confirm the write actually landed.
      if (this.storage.getItem(WORKSPACE_KEY) !== json) throw new Error('read-back mismatch')
      this.onState('saved')
      return true
    } catch (err) {
      const msg = (err as Error)?.name === 'QuotaExceededError' ? 'Browser storage is full.' : String((err as Error)?.message ?? err)
      this.onState('failed', msg)
      return false
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.latest = null
    try {
      this.storage?.removeItem(WORKSPACE_KEY)
    } catch {
      /* ignore */
    }
  }
}

// ---- Heartbeats & orphan cleanup ---------------------------------------------

export function writeHeartbeat(local: Storage | null, sessionId: string, now = Date.now()): void {
  try {
    local?.setItem(HEARTBEAT_PREFIX + sessionId, String(now))
  } catch {
    /* diagnostics only */
  }
}

export function removeHeartbeat(local: Storage | null, sessionId: string): void {
  try {
    local?.removeItem(HEARTBEAT_PREFIX + sessionId)
  } catch {
    /* ignore */
  }
}

/**
 * Decide which Krash databases can be deleted.
 *  - old generations of the current session;
 *  - databases of other sessions whose heartbeat is missing or stale.
 */
export function findOrphans(
  dbNames: string[],
  current: { sessionId: string; dbName: string | null },
  heartbeats: Map<string, number>,
  now = Date.now(),
): string[] {
  const out: string[] = []
  for (const name of dbNames) {
    const parsed = parseDbName(name)
    if (!parsed || name === current.dbName) continue
    if (parsed.sessionId === current.sessionId) {
      out.push(name)
      continue
    }
    const seen = heartbeats.get(parsed.sessionId)
    if (seen === undefined || now - seen > ORPHAN_AFTER_MS) out.push(name)
  }
  return out
}

export function readHeartbeats(local: Storage | null): Map<string, number> {
  const map = new Map<string, number>()
  if (!local) return map
  try {
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i)
      if (!key?.startsWith(HEARTBEAT_PREFIX)) continue
      const t = Number(local.getItem(key))
      if (Number.isFinite(t)) map.set(key.slice(HEARTBEAT_PREFIX.length), t)
    }
  } catch {
    /* ignore */
  }
  return map
}

export function pruneHeartbeats(local: Storage | null, now = Date.now()): void {
  if (!local) return
  for (const [id, t] of readHeartbeats(local)) if (now - t > ORPHAN_AFTER_MS) removeHeartbeat(local, id)
}
