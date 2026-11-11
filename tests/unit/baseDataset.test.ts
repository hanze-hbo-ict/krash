import { describe, expect, it } from 'vitest'
import { BASE_KEY, bundledBase, importedBase, importedDatasetId, loadBase, saveBase } from '../../src/workspace/baseDataset'

class MemoryStorage {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

const bundled = bundledBase({ id: 'webshop-v1', sql: 'create table a(x int);', expectedTables: ['a'] })

describe('base dataset', () => {
  it('derives a stable id from the script', () => {
    expect(importedDatasetId('select 1')).toBe(importedDatasetId('select 1'))
    expect(importedDatasetId('select 1')).not.toBe(importedDatasetId('select 2'))
    expect(importedDatasetId('x')).toMatch(/^import-[0-9a-f]{8}$/)
  })

  it('falls back to the bundled dataset', () => {
    const s = new MemoryStorage() as unknown as Storage
    expect(loadBase(s, bundled)).toBe(bundled)
    s.setItem(BASE_KEY, 'garbage')
    expect(loadBase(s, bundled)).toBe(bundled)
  })

  it('stores and restores an imported script', () => {
    const s = new MemoryStorage() as unknown as Storage
    const base = importedBase('create table b(y int);')
    expect(base.name).toBe('imported database')
    expect(saveBase(s, base)).toBe(true)
    expect(loadBase(s, bundled)).toEqual(base)
    expect(saveBase(s, bundled)).toBe(true)
    expect(s.getItem(BASE_KEY)).toBeNull()
  })
})
