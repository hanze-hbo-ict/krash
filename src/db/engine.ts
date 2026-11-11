/**
 * Database operations on a PGlite instance. Kept independent of the worker so
 * it can be integration-tested in Node with an in-memory database.
 */
import { protocol, type PGlite } from '@electric-sql/pglite'
import type { ExecuteOutcome, SchemaColumn, SchemaNamespace, SchemaRelation } from './protocol'
import { DEFAULT_LIMITS, WireReader, type WireLimits } from './wire'
import { findCopyFromStdin } from './sqlLexer'

export const DATASET_MARKER_PREFIX = 'krash-dataset:'

/** Error codes for problems detected by Krash itself (never sent to PostgreSQL). */
export const KRASH_UNSUPPORTED = 'KRASH'

export function unsupportedOutcome(message: string, hint?: string): ExecuteOutcome {
  return {
    results: [],
    statementCount: 0,
    resultsDropped: 0,
    error: { severity: 'ERROR', code: KRASH_UNSUPPORTED, message, hint },
    errorStatementIndex: null,
    notices: [],
    noticesDropped: 0,
    txStatus: 'I',
    complete: true,
    durationMs: 0,
  }
}

/**
 * Execute a script exactly as written using the simple-query protocol
 * (the same thing `psql -c` or pgAdmin's query tool send). PostgreSQL itself
 * splits the statements; multi-statement text runs as one implicit transaction
 * unless the script contains explicit transaction control.
 */
export async function executeScript(
  db: PGlite,
  sql: string,
  limits: Partial<WireLimits> = {},
): Promise<ExecuteOutcome> {
  if (findCopyFromStdin(sql) !== null) {
    const out = unsupportedOutcome(
      'COPY ... FROM STDIN is not supported in Krash. Nothing was executed.',
      'There is no client to read rows from in the browser. Use INSERT statements instead.',
    )
    out.txStatus = db.isInTransaction() ? 'T' : 'I'
    return out
  }
  const reader = new WireReader({ ...DEFAULT_LIMITS, ...limits })
  const started = performance.now()
  await db.runExclusive(() =>
    db.execProtocolRawStream(protocol.serialize.query(sql), {
      onRawData: (chunk) => reader.push(chunk),
    }),
  )
  const outcome = reader.finish(Math.round(performance.now() - started))
  await resolveTypeNames(db, outcome)
  return outcome
}

const BUILTIN_TYPES: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  18: '"char"',
  19: 'name',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'real',
  701: 'double precision',
  1042: 'character',
  1043: 'character varying',
  1082: 'date',
  1083: 'time without time zone',
  1114: 'timestamp without time zone',
  1184: 'timestamp with time zone',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
}

async function resolveTypeNames(db: PGlite, outcome: ExecuteOutcome): Promise<void> {
  const pairs = new Map<string, { oid: number; mod: number }>()
  for (const r of outcome.results) for (const c of r.columns ?? []) pairs.set(`${c.typeOid}:${c.typeMod}`, { oid: c.typeOid, mod: c.typeMod })
  if (pairs.size === 0) return
  const names = new Map<string, string>()
  // In an aborted transaction block every query fails; fall back to built-in names.
  if (outcome.txStatus !== 'E') {
    try {
      const list = [...pairs.values()]
      const res = await db.query<{ k: string; name: string }>(
        `select t.oid::text || ':' || m.mod::text as k, format_type(t.oid, nullif(m.mod, -1)) as name
           from unnest($1::oid[], $2::int[]) as m(oid, mod) join pg_type t on t.oid = m.oid`,
        [list.map((p) => p.oid), list.map((p) => p.mod)],
      )
      for (const row of res.rows) names.set(row.k, row.name)
    } catch {
      /* best effort only */
    }
  }
  for (const r of outcome.results)
    for (const c of r.columns ?? []) c.typeName = names.get(`${c.typeOid}:${c.typeMod}`) ?? BUILTIN_TYPES[c.typeOid] ?? null
}

const SCHEMA_SQL = `
select n.nspname as schema, c.relname as rel, c.relkind::text as kind,
       a.attname as col, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
       coalesce(exists (select 1 from pg_constraint pk
                         where pk.conrelid = c.oid and pk.contype = 'p' and a.attnum = any (pk.conkey)), false) as is_pk,
       (select string_agg(
                 case when fn.nspname = n.nspname then quote_ident(fc.relname)
                      else quote_ident(fn.nspname) || '.' || quote_ident(fc.relname) end
                 || '(' || quote_ident(fa.attname) || ')', ', ')
          from pg_constraint fk
          cross join lateral unnest(fk.conkey, fk.confkey) as k(col, refcol)
          join pg_class fc on fc.oid = fk.confrelid
          join pg_namespace fn on fn.oid = fc.relnamespace
          join pg_attribute fa on fa.attrelid = fk.confrelid and fa.attnum = k.refcol
         where fk.conrelid = c.oid and fk.contype = 'f' and k.col = a.attnum) as refs
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 where c.relkind in ('r', 'v', 'm', 'p', 'f')
   and n.nspname not in ('pg_catalog', 'information_schema')
   and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
 order by n.nspname, c.relname, a.attnum`

const NAMESPACES_SQL = `
select nspname as schema from pg_namespace
 where nspname not in ('pg_catalog', 'information_schema')
   and nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%'
 order by nspname = 'public' desc, nspname`

const KIND: Record<string, SchemaRelation['kind']> = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  p: 'partitioned table',
  f: 'foreign table',
}

export async function introspectSchema(db: PGlite): Promise<SchemaNamespace[]> {
  const nsRes = await db.query<{ schema: string }>(NAMESPACES_SQL)
  const res = await db.query<{
    schema: string
    rel: string
    kind: string
    col: string | null
    type: string | null
    not_null: boolean | null
    is_pk: boolean
    refs: string | null
  }>(SCHEMA_SQL)
  const byNs = new Map<string, Map<string, SchemaRelation>>()
  for (const { schema } of nsRes.rows) byNs.set(schema, new Map())
  for (const row of res.rows) {
    let rels = byNs.get(row.schema)
    if (!rels) byNs.set(row.schema, (rels = new Map()))
    let rel = rels.get(row.rel)
    if (!rel) rels.set(row.rel, (rel = { name: row.rel, kind: KIND[row.kind] ?? 'table', columns: [] }))
    if (row.col !== null) {
      const col: SchemaColumn = {
        name: row.col,
        type: row.type ?? '',
        notNull: !!row.not_null,
        isPrimaryKey: row.is_pk,
        references: row.refs,
      }
      rel.columns.push(col)
    }
  }
  return [...byNs].map(([name, rels]) => ({ name, relations: [...rels.values()] }))
}

export async function readDatasetMarker(db: PGlite): Promise<string | null> {
  const res = await db.query<{ d: string | null }>(
    `select shobj_description(oid, 'pg_database') as d from pg_database where datname = current_database()`,
  )
  const d = res.rows[0]?.d ?? null
  return d && d.startsWith(DATASET_MARKER_PREFIX) ? d.slice(DATASET_MARKER_PREFIX.length) : null
}

export async function hasUserRelations(db: PGlite): Promise<boolean> {
  const res = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'`,
  )
  return (res.rows[0]?.n ?? 0) > 0
}

export class SeedError extends Error {}

/**
 * Apply the seed script and stamp the dataset marker. The caller is expected to
 * run this only on a brand-new database and discard that database on failure.
 */
export async function seedDatabase(
  db: PGlite,
  seedSql: string,
  datasetId: string,
  expectedTables: string[] = [],
): Promise<void> {
  const outcome = await executeScript(db, seedSql, { maxRows: 0, maxResults: 0, maxNotices: 0 })
  if (outcome.error) {
    throw new SeedError(`The exam dataset could not be loaded: ${outcome.error.message}`)
  }
  if (outcome.txStatus !== 'I') {
    await db.exec('rollback')
    throw new SeedError('The exam dataset script left a transaction open.')
  }
  if (expectedTables.length > 0) {
    const res = await db.query<{ t: string }>(`select t from unnest($1::text[]) as t where to_regclass(t) is null`, [
      expectedTables,
    ])
    if (res.rows.length > 0) {
      throw new SeedError(`The exam dataset is missing expected tables: ${res.rows.map((r) => r.t).join(', ')}`)
    }
  }
  await db.exec(
    `do $krash$ begin execute format('comment on database %I is %L', current_database(), ${quoteLiteral(
      DATASET_MARKER_PREFIX + datasetId,
    )}); end $krash$`,
  )
  const marker = await readDatasetMarker(db)
  if (marker !== datasetId) throw new SeedError('The dataset marker could not be verified after loading.')
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}
