import { describe, expect, it } from 'vitest'
import {
  createWorkspace,
  DEFAULT_QUERY,
  findOrphans,
  loadWorkspace,
  ORPHAN_AFTER_MS,
  parseWorkspace,
  WORKSPACE_KEY,
  WorkspaceSaver,
  type SaveState,
} from '../../src/workspace/sessionStore'

class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  failWrites = false
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.get(k) ?? null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) {
    if (this.failWrites) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e }
    this.m.set(k, v)
  }
}

describe('workspace persistence', () => {
  it('creates a workspace with the default query', () => {
    const ws = createWorkspace(true)
    expect(ws.sql).toBe(DEFAULT_QUERY)
    expect(ws.dbName).toBe(`krash-${ws.sessionId}-1`)
    expect(createWorkspace(false).dbName).toBeNull()
  })

  it('saves and reloads', () => {
    const storage = new MemoryStorage()
    const states: SaveState[] = []
    const saver = new WorkspaceSaver(storage, (s) => states.push(s), 0)
    const ws = { ...createWorkspace(true), sql: 'select 1;' }
    saver.schedule(ws)
    expect(saver.flush()).toBe(true)
    expect(states).toEqual(['saving', 'saved'])
    expect(loadWorkspace(storage)).toEqual(ws)
  })

  it('reports quota failures', () => {
    const storage = new MemoryStorage()
    storage.failWrites = true
    const errors: string[] = []
    const saver = new WorkspaceSaver(storage, (s, e) => { if (s === 'failed') errors.push(e ?? '') }, 0)
    saver.schedule(createWorkspace(true))
    expect(saver.flush()).toBe(false)
    expect(errors[0]).toMatch(/full/)
  })

  it('rejects malformed or tampered state', () => {
    expect(parseWorkspace('{')).toBeNull()
    expect(parseWorkspace(JSON.stringify({ version: 2 }))).toBeNull()
    const ws = createWorkspace(true)
    expect(parseWorkspace(JSON.stringify({ ...ws, dbName: 'krash-othersession123-1' }))).toBeNull()
    expect(parseWorkspace(JSON.stringify({ ...ws, dbName: '../../x' }))).toBeNull()
    const { sql: _sql, ...noSql } = ws
    expect(parseWorkspace(JSON.stringify(noSql))).toBeNull()
    const storage = new MemoryStorage()
    storage.setItem(WORKSPACE_KEY, 'garbage')
    expect(loadWorkspace(storage)).toBeNull()
  })

  it('migrates state from the earlier multi-tab format', () => {
    const ws = createWorkspace(true)
    const { sql: _sql, ...rest } = ws
    const legacy = { ...rest, activeId: 'b', docs: [{ id: 'a', name: 'Q1', sql: 'select 1;' }, { id: 'b', name: 'Q2', sql: 'select 2;' }] }
    expect(parseWorkspace(JSON.stringify(legacy))?.sql).toBe('select 2;')
  })

  it('identifies orphaned databases conservatively', () => {
    const now = 10 * ORPHAN_AFTER_MS
    const current = { sessionId: 'aaaaaaaaaaaaaaaa', dbName: 'krash-aaaaaaaaaaaaaaaa-2' }
    const beats = new Map([
      ['bbbbbbbbbbbbbbbb', now - 1000],
      ['cccccccccccccccc', now - ORPHAN_AFTER_MS - 1],
    ])
    const orphans = findOrphans(
      [
        'krash-aaaaaaaaaaaaaaaa-2', // current
        'krash-aaaaaaaaaaaaaaaa-1', // old generation of this session
        'krash-bbbbbbbbbbbbbbbb-1', // live other tab
        'krash-cccccccccccccccc-1', // stale
        'krash-dddddddddddddddd-1', // no heartbeat
        'someone-else',
      ],
      current,
      beats,
      now,
    )
    expect(orphans.sort()).toEqual(['krash-aaaaaaaaaaaaaaaa-1', 'krash-cccccccccccccccc-1', 'krash-dddddddddddddddd-1'])
  })
})
