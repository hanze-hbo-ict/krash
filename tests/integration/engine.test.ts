import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  executeScript,
  hasUserRelations,
  introspectSchema,
  readDatasetMarker,
  SeedError,
  seedDatabase,
} from '../../src/db/engine'

const seedSql = readFileSync(new URL('../../src/exam/seed.sql', import.meta.url), 'utf8')
const expected = ['categories', 'products', 'customers', 'employees', 'orders', 'order_lines', 'reviews']

let db: PGlite

beforeAll(async () => {
  db = await PGlite.create()
  expect(await hasUserRelations(db)).toBe(false)
  expect(await readDatasetMarker(db)).toBeNull()
  await seedDatabase(db, seedSql, 'webshop-v1', expected)
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
    const fresh = await PGlite.create()
    await expect(seedDatabase(fresh, 'create table a(x int); insert into a values (1/0);', 'x')).rejects.toBeInstanceOf(SeedError)
    await expect(seedDatabase(fresh, 'create table b(x int);', 'x', ['missing_table'])).rejects.toThrow(/missing expected tables/)
    await fresh.close()
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
  it('lists schemas, tables, views, columns, keys and references', async () => {
    await executeScript(db, `create schema exam; create table exam.t (id int primary key, cust int references public.customers(id));`)
    const schema = await introspectSchema(db)
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
