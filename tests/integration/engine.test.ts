import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildDatabases,
  executeScript,
  hasUserRelations,
  introspectSchema,
  listDatabases,
  listUsers,
  readDatasetMarker,
  setSessionUser,
  SeedError,
  type Reconnect,
} from '../../src/db/engine'

const seedSql = readFileSync(new URL('../fixtures/webshop.sql', import.meta.url), 'utf8')
const expected = ['categories', 'products', 'customers', 'employees', 'orders', 'order_lines', 'reviews']

let db: PGlite

/** The in-memory equivalent of psql's \c, as the worker does for temporary databases. */
const reconnect: Reconnect = async (conn, database) => {
  const dump = await conn.dumpDataDir('none')
  await conn.close()
  return PGlite.create({ loadDataDir: dump, database })
}

async function build(sql: string, expectedTables: string[] = []) {
  return buildDatabases(await PGlite.create(), { id: 'test', sql, expectedTables }, reconnect)
}

beforeAll(async () => {
  const fresh = await PGlite.create()
  expect(await hasUserRelations(fresh)).toBe(false)
  expect(await readDatasetMarker(fresh)).toBeNull()
  const result = await buildDatabases(fresh, { id: 'webshop-v1', sql: seedSql, expectedTables: expected }, reconnect)
  expect(result).toMatchObject({ database: 'postgres', databases: ['postgres'] })
  db = result.db
})

describe('seeding', () => {
  it('stamps and verifies the dataset marker', async () => {
    expect(await readDatasetMarker(db)).toBe('webshop-v1')
    expect(await hasUserRelations(db)).toBe(true)
  })

  it('loads a deterministic dataset', async () => {
    const out = await executeScript(
      db,
      `select (select count(*) from customers) c, (select count(*) from orders) o,
              (select count(*) from order_lines) l, (select sum(quantity * unit_price) from order_lines) revenue`,
    )
    expect(out.error).toBeNull()
    expect(out.results[0]!.rows[0]).toEqual(['30', '240', '600', expect.any(String)])
    // Stable across runs: snapshot the revenue so dataset changes are deliberate.
    expect(out.results[0]!.rows[0]![3]).toMatchInlineSnapshot(`"42768.48"`)
  })

  it('refuses a broken seed', async () => {
    await expect(build('create table a(x int); insert into a values (1/0);')).rejects.toBeInstanceOf(SeedError)
    await expect(build('create table b(x int);', ['missing_table'])).rejects.toThrow(/missing expected tables/)
    await expect(build('create database shop; create table c(x int); select 1/0;')).rejects.toThrow(/\(in shop\): division by zero/)
  })
})

describe('import scripts with CREATE DATABASE', () => {
  it('runs each section in the database it created and ends connected to the last one', { timeout: 120_000 }, async () => {
    const result = await build(`
      -- roles are cluster-wide
      create role clerk;
      create database shop;
      create table products (id int primary key, name text);
      insert into products values (1, 'pen');
      grant connect on database shop to clerk;
      grant select on products to clerk;
      CREATE DATABASE archive;
      create table old_orders (id int);
    `)
    expect(result.database).toBe('archive')
    expect(result.databases).toEqual(['postgres', 'shop', 'archive'])
    let conn = result.db
    expect((await introspectSchema(conn)).namespaces[0]!.relations.map((r) => r.name)).toEqual(['old_orders'])
    expect(await listDatabases(conn)).toEqual(['archive', 'postgres', 'shop'])
    // The marker is readable from any database.
    expect(await readDatasetMarker(conn)).toBe('test')
    conn = await reconnect(conn, 'shop')
    const shop = await introspectSchema(conn)
    expect(shop.database).toBe('shop')
    expect(shop.namespaces[0]!.relations.map((r) => r.name)).toEqual(['products'])
    const acl = await executeScript(conn, `select has_table_privilege('clerk', 'products', 'select'), has_database_privilege('clerk', 'shop', 'connect')`)
    expect(acl.results[0]!.rows[0]).toEqual(['t', 't'])
    await conn.close()
  })

  it('does not touch postgres when the script starts with CREATE DATABASE', { timeout: 120_000 }, async () => {
    const result = await build('-- a comment first\ncreate database shop;\ncreate table t (x int);')
    expect(result).toMatchObject({ database: 'shop', databases: ['shop'] })
    await result.db.close()
  })

  it('rejects CREATE DATABASE combined with other statements in one editor run (PostgreSQL rule)', async () => {
    const out = await executeScript(db, 'select 1; create database nope;')
    expect(out.error?.message).toMatch(/cannot run inside a transaction block/)
  })
})

describe('execution', () => {
  it('returns column names for empty results and SQL NULL distinctly', async () => {
    const out = await executeScript(db, `select id, birth_date, 'NULL' as text_null from customers where birth_date is null order by id limit 1; select * from customers where false;`)
    expect(out.error).toBeNull()
    expect(out.results[0]!.rows[0]).toEqual(['4', null, 'NULL'])
    expect(out.results[1]!.columns!.map((c) => c.name)).toContain('email')
    expect(out.results[1]!.rows).toEqual([])
    expect(out.results[1]!.rowCount).toBe(0)
  })

  it('formats values the way PostgreSQL does (text protocol)', async () => {
    const out = await executeScript(
      db,
      `select true as b, 1.50::numeric(8,2) as n, date '2024-02-29' as d, '{"a": 1}'::jsonb as j,
              array['x', null] as arr, interval '1 day 2 hours' as i, 9007199254740993::bigint as big`,
    )
    expect(out.results[0]!.rows[0]).toEqual(['t', '1.50', '2024-02-29', '{"a": 1}', '{x,NULL}', '1 day 02:00:00', '9007199254740993'])
    expect(out.results[0]!.columns!.map((c) => c.typeName)).toEqual([
      'boolean',
      'numeric(8,2)',
      'date',
      'jsonb',
      'text[]',
      'interval',
      'bigint',
    ])
  })

  it('passes scripts with comments, string semicolons and dollar quoting intact', async () => {
    const out = await executeScript(
      db,
      `-- a comment; with a semicolon
       create table notes (id serial primary key, body text);
       insert into notes (body) values ('a;b'), ($$c;'d'$$), (E'e\\;f');
       /* block; comment */
       create function note_count() returns bigint language plpgsql as $fn$
       begin
         return (select count(*) from notes); -- inner ; semicolon
       end;
       $fn$;
       select body from notes order by id;
       select note_count();`,
    )
    expect(out.error).toBeNull()
    expect(out.results.map((r) => r.command)).toEqual(['CREATE TABLE', 'INSERT', 'CREATE FUNCTION', 'SELECT', 'SELECT'])
    expect(out.results[1]!.rowCount).toBe(3)
    expect(out.results[3]!.rows).toEqual([['a;b'], ["c;'d'"], ['e;f']])
    expect(out.results[4]!.rows).toEqual([['3']])
    await executeScript(db, 'drop function note_count(); drop table notes;')
  })

  it('reports a genuine syntax error with position and executes nothing', async () => {
    const sql = `insert into categories values (100, 'x', null);\nselec 1;`
    const out = await executeScript(db, sql)
    expect(out.error).toMatchObject({ code: '42601', message: 'syntax error at or near "selec"' })
    expect(Number(out.error!.position)).toBe(sql.indexOf('selec') + 1)
    expect(out.results).toEqual([])
    const check = await executeScript(db, 'select count(*) from categories where id = 100')
    expect(check.results[0]!.rows).toEqual([['0']])
  })

  it('reports partial execution of a script that fails at run time (implicit transaction)', async () => {
    const out = await executeScript(db, `insert into categories values (101, 'tmp', null); select 1 as ok; select 1/0;`)
    expect(out.error?.code).toBe('22012')
    expect(out.errorStatementIndex).toBe(3)
    expect(out.results.map((r) => r.command)).toEqual(['INSERT', 'SELECT'])
    expect(out.txStatus).toBe('I')
    // PostgreSQL rolled back the implicit transaction of the simple query.
    const check = await executeScript(db, 'select count(*) from categories where id = 101')
    expect(check.results[0]!.rows).toEqual([['0']])
  })

  it('keeps explicit transactions open across runs, like one psql session', async () => {
    let out = await executeScript(db, `begin; update products set stock = stock + 1 where id = 1;`)
    expect(out.txStatus).toBe('T')
    out = await executeScript(db, `select 1/0;`)
    expect(out.txStatus).toBe('E')
    out = await executeScript(db, `select 1;`)
    expect(out.error?.code).toBe('25P02')
    out = await executeScript(db, `rollback;`)
    expect(out.txStatus).toBe('I')
    out = await executeScript(db, `begin; savepoint s; delete from reviews; rollback to savepoint s; commit; select count(*) from reviews;`)
    expect(out.error).toBeNull()
    expect(out.results.at(-1)!.rows).toEqual([['12']])
  })

  it('supports typical exam topics', async () => {
    const out = await executeScript(
      db,
      `with totals as (
         select o.customer_id, sum(l.quantity * l.unit_price) as total
           from orders o join order_lines l on l.order_id = o.id
          where o.status <> 'cancelled'
          group by o.customer_id
         having count(*) > 1
       )
       select c.last_name, t.total, rank() over (order by t.total desc) as rnk
         from totals t join customers c on c.id = t.customer_id
        order by rnk, c.last_name limit 3;
       select e.name, m.name as manager from employees e left join employees m on m.id = e.manager_id order by e.id;
       select name from products where price > (select avg(price) from products) and category_id in (select id from categories where parent_id = 7);
       create view busy_customers as select customer_id, count(*) n from orders group by customer_id having count(*) >= 8;
       select count(*) from busy_customers;
       alter table customers add column phone varchar(20);
       update customers set phone = '050-0000000' where city = 'Groningen';
       delete from reviews where rating = 1;
       select * from product_catalogue where category = 'Cycling' order by price;`,
    )
    expect(out.error).toBeNull()
    expect(out.results).toHaveLength(9)
    expect(out.results[0]!.columns!.map((c) => c.name)).toEqual(['last_name', 'total', 'rnk'])
    expect(out.results[1]!.rows[0]).toEqual(['Marieke Hoekstra', null])
    expect(out.results[6]!.command).toBe('UPDATE')
    expect(out.results[7]!).toMatchObject({ command: 'DELETE', rowCount: 1 })
  })

  it('truncates huge results but keeps the exact row count', async () => {
    const out = await executeScript(db, `select g from generate_series(1, 200000) g`, { maxRows: 1000 })
    expect(out.results[0]!.rows).toHaveLength(1000)
    expect(out.results[0]!.totalRows).toBe(200000)
    expect(out.results[0]!.rowsTruncated).toBe(true)
    expect(out.results[0]!.rowCount).toBe(200000)
  })

  it('refuses COPY FROM STDIN before it reaches the engine', async () => {
    const out = await executeScript(db, `select 1; copy categories from stdin;`)
    expect(out.error?.code).toBe('KRASH')
    expect(out.results).toEqual([])
    const after = await executeScript(db, 'select 42')
    expect(after.results[0]!.rows).toEqual([['42']])
  })

  it('collects notices and COPY TO STDOUT output', async () => {
    const out = await executeScript(db, `do $$ begin raise notice 'hello %', 42; end $$; copy (select id, name from categories where id <= 2 order by id) to stdout with (format csv);`)
    expect(out.notices[0]).toMatchObject({ severity: 'NOTICE', message: 'hello 42' })
    expect(out.results[1]!.copyText).toBe('1,Kitchen\n2,Coffee & tea\n')
  })

  it('treats an empty or comment-only script as nothing to do', async () => {
    for (const sql of ['', '   ', '-- just a comment']) {
      const out = await executeScript(db, sql)
      expect(out.error).toBeNull()
      expect(out.results).toEqual([])
      expect(out.statementCount).toBe(0)
    }
  })
})

describe('schema introspection', () => {
  it('lists databases created with CREATE DATABASE, and database grants work', async () => {
    const out = await executeScript(db, 'create role reader; grant connect on database postgres to reader;')
    expect(out.error).toBeNull()
    expect((await executeScript(db, 'create database archive;')).error).toBeNull()
    const info = await introspectSchema(db)
    expect(info.database).toBe('postgres')
    expect(info.allDatabases).toEqual(['archive', 'postgres'])
    await executeScript(db, 'drop database archive;')
  })


  it('lists schemas, tables, views, columns, keys and references', async () => {
    await executeScript(db, `create schema exam; create table exam.t (id int primary key, cust int references public.customers(id));`)
    const info = await introspectSchema(db)
    expect(info.allDatabases).toEqual(['postgres'])
    const schema = info.namespaces
    expect(schema.map((s) => s.name)).toEqual(['public', 'exam'])
    const pub = schema[0]!
    const orders = pub.relations.find((r) => r.name === 'orders')!
    expect(orders.kind).toBe('table')
    expect(orders.columns[0]).toEqual({ name: 'id', type: 'integer', notNull: true, isPrimaryKey: true, references: null })
    expect(orders.columns.find((c) => c.name === 'customer_id')!.references).toBe('customers(id)')
    const lines = pub.relations.find((r) => r.name === 'order_lines')!
    expect(lines.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(['order_id', 'line_no'])
    expect(pub.relations.find((r) => r.name === 'product_catalogue')!.kind).toBe('view')
    expect(pub.relations.find((r) => r.name === 'products')!.columns.find((c) => c.name === 'price')!.type).toBe('numeric(8,2)')
    expect(schema[1]!.relations[0]!.columns[1]!.references).toBe('public.customers(id)')
  })
})

describe('users', () => {
  it('lists login roles, switches the session user and enforces privileges', async () => {
    const conn = await PGlite.create()
    await executeScript(
      conn,
      `create table t (x int); insert into t values (1);
       create user alice; create user bob; create role readers; grant select on t to alice;`,
    )
    expect(await listUsers(conn)).toEqual(['postgres', 'alice', 'bob'])
    await expect(setSessionUser(conn, 'readers')).rejects.toThrow(/cannot log in/)
    await expect(setSessionUser(conn, 'nobody')).rejects.toThrow(/does not exist/)

    await setSessionUser(conn, 'alice')
    const info = await introspectSchema(conn)
    expect(info).toMatchObject({ user: 'alice', role: 'alice', users: ['postgres', 'alice', 'bob'] })
    expect(info.namespaces[0]!.relations.map((r) => r.name)).toEqual(['t'])
    expect((await executeScript(conn, 'select x from t')).results[0]!.rows).toEqual([['1']])
    expect((await executeScript(conn, 'insert into t values (2)')).error?.message).toBe('permission denied for table t')
    // Unlike SET ROLE (PGlite's own username option), RESET ROLE does not get back to postgres.
    expect((await executeScript(conn, 'set role postgres')).error?.message).toMatch(/permission denied to set role/)
    await executeScript(conn, 'reset role')
    expect((await introspectSchema(conn)).role).toBe('alice')

    await setSessionUser(conn, 'bob')
    expect((await executeScript(conn, 'select x from t')).error?.message).toBe('permission denied for table t')
    await conn.close()
  })
})
