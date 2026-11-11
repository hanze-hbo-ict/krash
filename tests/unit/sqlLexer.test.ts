import { describe, expect, it } from 'vitest'
import { findCopyFromStdin, lexWords, offsetToLineCol, pgPositionToOffset } from '../../src/db/sqlLexer'

describe('findCopyFromStdin', () => {
  it('detects COPY ... FROM STDIN in any case', () => {
    expect(findCopyFromStdin('COPY t FROM STDIN')).toBe(0)
    expect(findCopyFromStdin('select 1;\n  copy t (a, b) from stdin with (format csv);')).toBe(12)
  })
  it('ignores strings, comments, quoted identifiers and dollar bodies', () => {
    expect(findCopyFromStdin(`select 'copy t from stdin'`)).toBeNull()
    expect(findCopyFromStdin(`-- copy t from stdin\nselect 1`)).toBeNull()
    expect(findCopyFromStdin(`/* copy t from stdin /* nested */ still */ select 1`)).toBeNull()
    expect(findCopyFromStdin(`create function f() returns void language sql as $$ copy t from stdin $$`)).toBeNull()
    expect(findCopyFromStdin(`select $tag$ ; copy t from stdin $tag$`)).toBeNull()
    expect(findCopyFromStdin(`select "copy" from stdin_table`)).toBeNull()
    expect(findCopyFromStdin(`select E'\\' copy t from stdin'`)).toBeNull()
  })
  it('allows COPY TO STDOUT and SELECTs from a table called stdin', () => {
    expect(findCopyFromStdin('copy t to stdout')).toBeNull()
    expect(findCopyFromStdin('select * from stdin')).toBeNull()
  })
})

describe('lexWords', () => {
  it('splits only at top-level semicolons', () => {
    const s = lexWords(`select 'a;b'; select $$;$$; select 1`)
    expect(s.length).toBe(3)
  })
})

describe('positions', () => {
  it('maps PostgreSQL character positions to JS offsets with astral characters', () => {
    const sql = "select '😀', foo"
    // PostgreSQL counts 😀 as one character: "foo" starts at character 13.
    expect(pgPositionToOffset(sql, 13)).toBe(sql.indexOf('foo'))
  })
  it('computes 1-based line and column', () => {
    expect(offsetToLineCol('a\nbc\ndef', 6)).toEqual({ line: 3, col: 2 })
    expect(offsetToLineCol('abc', 0)).toEqual({ line: 1, col: 1 })
  })
})
