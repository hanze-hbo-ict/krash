import { describe, expect, it } from 'vitest'
import { findCopyFromStdin, lexWords, offsetToLineCol, pgPositionToOffset, splitByCreateDatabase, statementAt } from '../../src/db/sqlLexer'

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

describe('splitByCreateDatabase', () => {
  it('returns one postgres section when there is no CREATE DATABASE', () => {
    const s = splitByCreateDatabase('create table t (x int);\n-- note\ninsert into t values (1);')
    expect(s).toEqual([{ createDatabase: null, body: 'create table t (x int);\n-- note\ninsert into t values (1);', hasStatements: true }])
  })

  it('splits at each top-level CREATE DATABASE, keeping text as written', () => {
    const sql = "-- setup\ncreate role clerk;\nCREATE DATABASE shop;\ncreate table p (id int);\ncreate database \"Archive\" with encoding 'UTF8';\ncreate table old (x text);\n"
    const s = splitByCreateDatabase(sql)
    expect(s.map((x) => x.createDatabase)).toEqual([null, 'CREATE DATABASE shop;', 'create database "Archive" with encoding \'UTF8\';'])
    expect(s[0]).toMatchObject({ body: '-- setup\ncreate role clerk;\n', hasStatements: true })
    expect(s[1]).toMatchObject({ body: '\ncreate table p (id int);\n', hasStatements: true })
    expect(s[2]).toMatchObject({ body: '\ncreate table old (x text);\n', hasStatements: true })
  })

  it('marks an empty preamble and ignores CREATE DATABASE inside strings, comments and bodies', () => {
    const sql = "-- only a comment\ncreate database shop;\nselect 'create database x;';\n/* create database y; */\ncreate function f() returns void language sql as $$ select 1; $$;"
    const s = splitByCreateDatabase(sql)
    expect(s).toHaveLength(2)
    expect(s[0]!.hasStatements).toBe(false)
    expect(s[1]!.createDatabase).toBe('create database shop;')
  })
})

describe('statementAt', () => {
  const at = (sql: string, cursor: number) => {
    const r = statementAt(sql, cursor)
    return r && sql.slice(r.start, r.end)
  }
  const sql = 'select 1;\n\n-- second\nselect 2;select 3\n'
  it('picks the statement around the cursor, including its leading comment', () => {
    expect(at(sql, 3)).toBe('select 1;')
    expect(at(sql, sql.indexOf('2'))).toBe('-- second\nselect 2;')
    expect(at(sql, sql.length)).toBe('select 3')
  })
  it('prefers the statement that ends at the cursor, then the one before a gap', () => {
    expect(at(sql, sql.indexOf('select 3'))).toBe('-- second\nselect 2;')
    expect(at(sql, sql.indexOf('\n\n') + 1)).toBe('select 1;')
    expect(at('\n\nselect 1;', 0)).toBe('select 1;')
  })
  it('does not split inside strings or dollar bodies, and ignores comment-only text', () => {
    const body = "select ';' as a, $$;$$ as b;"
    expect(at(body, 5)).toBe(body)
    expect(statementAt('-- nothing;\n', 2)).toBeNull()
    expect(statementAt('', 0)).toBeNull()
  })
})
