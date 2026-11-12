import { describe, expect, it } from 'vitest'
import { shortType } from '../../src/app/describe'

describe('shortType', () => {
  it('uses varchar and char', () => {
    expect(shortType('character varying(50)')).toBe('varchar(50)')
    expect(shortType('character varying')).toBe('varchar')
    expect(shortType('character(3)')).toBe('char(3)')
    expect(shortType('character varying[]')).toBe('varchar[]')
  })
  it('uses timestamp, timestamptz, time and timetz, keeping the precision', () => {
    expect(shortType('timestamp without time zone')).toBe('timestamp')
    expect(shortType('timestamp with time zone')).toBe('timestamptz')
    expect(shortType('timestamp(3) with time zone')).toBe('timestamptz(3)')
    expect(shortType('time without time zone')).toBe('time')
    expect(shortType('time(0) with time zone')).toBe('timetz(0)')
    expect(shortType('timestamp without time zone[]')).toBe('timestamp[]')
  })
  it('leaves other types alone', () => {
    for (const t of ['integer', 'numeric(8,2)', 'date', 'interval', 'text', '"char"']) expect(shortType(t)).toBe(t)
  })
})
