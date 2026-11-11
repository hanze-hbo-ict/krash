import { describe, expect, it } from 'vitest'
import { parseCommandTag, WireReader, DEFAULT_LIMITS } from '../../src/db/wire'

function msg(type: string, body: number[]): number[] {
  const len = body.length + 4
  return [type.charCodeAt(0), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body]
}
const enc = new TextEncoder()
const cstr = (s: string) => [...enc.encode(s), 0]
const i16 = (n: number) => [(n >> 8) & 255, n & 255]
const i32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function rowDesc(cols: string[]) {
  return msg('T', [...i16(cols.length), ...cols.flatMap((c) => [...cstr(c), ...i32(0), ...i16(0), ...i32(25), ...i16(-1), ...i32(-1), ...i16(0)])])
}
function dataRow(vals: (string | null)[]) {
  return msg('D', [...i16(vals.length), ...vals.flatMap((v) => (v === null ? i32(-1) : [...i32(enc.encode(v).length), ...enc.encode(v)]))])
}

describe('parseCommandTag', () => {
  it('parses common tags', () => {
    expect(parseCommandTag('INSERT 0 3')).toEqual({ command: 'INSERT', rowCount: 3 })
    expect(parseCommandTag('SELECT 2')).toEqual({ command: 'SELECT', rowCount: 2 })
    expect(parseCommandTag('CREATE TABLE')).toEqual({ command: 'CREATE TABLE', rowCount: null })
  })
})

describe('WireReader', () => {
  it('handles messages split across arbitrary chunk boundaries', () => {
    const bytes = Uint8Array.from([...rowDesc(['a', 'b']), ...dataRow(['1', null]), ...msg('C', cstr('SELECT 1')), ...msg('Z', ['I'.charCodeAt(0)])])
    for (const size of [1, 3, 7, bytes.length]) {
      const r = new WireReader()
      for (let i = 0; i < bytes.length; i += size) r.push(bytes.subarray(i, i + size))
      const out = r.finish(0)
      expect(out.results[0]!.columns!.map((c) => c.name)).toEqual(['a', 'b'])
      expect(out.results[0]!.rows).toEqual([['1', null]])
      expect(out.complete).toBe(true)
    }
  })

  it('bounds rows and cells without losing the true row count', () => {
    const r = new WireReader({ ...DEFAULT_LIMITS, maxRows: 2, maxCellChars: 3 })
    r.push(Uint8Array.from([...rowDesc(['x']), ...dataRow(['abcdef']), ...dataRow(['b']), ...dataRow(['c']), ...msg('C', cstr('SELECT 3'))]))
    const res = r.finish(0).results[0]!
    expect(res.rows).toEqual([['abc'], ['b']])
    expect(res.totalRows).toBe(3)
    expect(res.rowsTruncated).toBe(true)
    expect(res.cellsTruncated).toBe(true)
  })

  it('reports errors with the failing statement number', () => {
    const err = msg('E', [...cstr('SERROR'), ...cstr('C42P01'), ...cstr('Mrelation "x" does not exist'), ...cstr('P15'), 0])
    const r = new WireReader()
    r.push(Uint8Array.from([...msg('C', cstr('CREATE TABLE')), ...err, ...msg('Z', ['I'.charCodeAt(0)])]))
    const out = r.finish(0)
    expect(out.error).toMatchObject({ code: '42P01', message: 'relation "x" does not exist', position: '15' })
    expect(out.errorStatementIndex).toBe(2)
    expect(out.results).toHaveLength(1)
  })
})
