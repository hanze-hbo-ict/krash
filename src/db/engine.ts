/**
 * Database operations on a PGlite instance. Kept independent of the worker so
 * it can be integration-tested in Node with an in-memory database.
 */
import { protocol, type PGlite } from '@electric-sql/pglite'
import type { DatasetSpec, ExecuteOutcome, SchemaColumn, SchemaInfo, SchemaRelation } from './protocol'
import { DEFAULT_LIMITS, WireReader, type WireLimits } from './wire'
import { findCopyFromStdin, splitByCreateDatabase } from './sqlLexer'

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
         where fk.conrelid = c.oid and fk.contype = 'f' and k.col = a.attnum) as refs,
       -- serial is integer + a nextval default + a sequence owned by the column (identity columns also own one).
       coalesce(a.attidentity = '' and a.atthasdef
                and pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) is not null, false) as is_serial
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

/** The type name a serial column was declared with. */
const SERIAL: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }

const KIND: Record<string, SchemaRelation['kind']> = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  p: 'partitioned table',
  f: 'foreign table',
}

export async function introspectSchema(db: PGlite): Promise<SchemaInfo> {
  const current = await db.query<{ d: string; u: string; r: string }>(
    `select current_database() as d, session_user::text as u, current_user::text as r`,
  )
  const allDatabases = await listDatabases(db)
  const users = await listUsers(db)
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
    is_serial: boolean
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
        type: row.is_serial ? (SERIAL[row.type ?? ''] ?? row.type ?? '') : (row.type ?? ''),
        notNull: !!row.not_null,
        isPrimaryKey: row.is_pk,
        references: row.refs,
      }
      rel.columns.push(col)
    }
  }
  return {
    database: current.rows[0]?.d ?? '',
    allDatabases,
    user: current.rows[0]?.u ?? '',
    role: current.rows[0]?.r ?? '',
    users,
    namespaces: [...byNs].map(([name, rels]) => ({ name, relations: [...rels.values()] })),
  }
}

/** All non-template databases of the cluster, by name. */
export async function listDatabases(db: PGlite): Promise<string[]> {
  const res = await db.query<{ d: string }>(`select datname::text as d from pg_database where not datistemplate order by 1`)
  return res.rows.map((r) => r.d)
}

/** Roles that can log in (CREATE USER, not CREATE ROLE), without the built-in pg_* roles. */
export async function listUsers(db: PGlite): Promise<string[]> {
  const res = await db.query<{ u: string }>(
    `select rolname::text as u from pg_roles where rolcanlogin and rolname !~ '^pg_' order by rolname = 'postgres' desc, 1`,
  )
  return res.rows.map((r) => r.u)
}

/** The user (session_user) of this session. */
export async function sessionUser(db: PGlite): Promise<string> {
  return (await db.query<{ u: string }>(`select session_user::text as u`)).rows[0]?.u ?? 'postgres'
}

/**
 * Continue this session as `user`, like connecting as that user. PGlite has no
 * authentication; its own `username` option only does SET ROLE, which RESET ROLE
 * undoes. SET SESSION AUTHORIZATION also changes session_user, so SET ROLE to a
 * role the user is not a member of is refused, as in a real connection.
 * (It is not a security boundary: the authenticated user is still postgres.)
 */
export async function setSessionUser(db: PGlite, user: string): Promise<void> {
  if (!(await listUsers(db)).includes(user)) throw new Error(`The user “${user}” does not exist or cannot log in.`)
  await db.exec(`set session authorization ${quoteIdent(user)}`)
}

/**
 * The dataset marker is a comment on the `postgres` database: database comments
 * are cluster-wide, so it can be read whichever database we are connected to.
 */
export async function readDatasetMarker(db: PGlite): Promise<string | null> {
  const res = await db.query<{ d: string | null }>(
    `select shobj_description(oid, 'pg_database') as d from pg_database where datname = 'postgres'`,
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

/** Reconnects the same cluster to another database; closes `db` and returns the new connection. */
export type Reconnect = (db: PGlite, database: string) => Promise<PGlite>

export interface BuildResult {
  /** The open connection, to the database the script ended in. */
  db: PGlite
  database: string
  /** Databases the script ran statements in or created, in script order. */
  databases: string[]
}

async function runPart(db: PGlite, sql: string, where: string): Promise<void> {
  const outcome = await executeScript(db, sql, { maxRows: 0, maxResults: 0, maxNotices: 0 })
  if (outcome.error) throw new SeedError(`The dataset could not be loaded${where}: ${outcome.error.message}`)
  if (outcome.txStatus !== 'I') {
    await db.exec('rollback')
    throw new SeedError(`The dataset script left a transaction open${where}.`)
  }
}

/**
 * Build a dataset on a brand-new cluster, connected to `postgres`. Like
 * `psql -f` with a `\c` after every `CREATE DATABASE`: statements before the
 * first `CREATE DATABASE` run in `postgres`; each `CREATE DATABASE` runs on its
 * own, after which the following statements run in the new database.
 * On failure the current connection is closed and a SeedError is thrown; the
 * caller discards the cluster.
 */
export async function buildDatabases(db: PGlite, dataset: DatasetSpec, reconnect: Reconnect): Promise<BuildResult> {
  let conn = db
  try {
    const sections = splitByCreateDatabase(dataset.sql)
    const databases: string[] = []
    let current = 'postgres'
    for (const section of sections) {
      if (section.createDatabase !== null) {
        const before = new Set(await listDatabases(conn))
        await runPart(conn, section.createDatabase, current === 'postgres' ? '' : ` (in ${current})`)
        const created = (await listDatabases(conn)).filter((d) => !before.has(d))
        if (created.length !== 1) throw new SeedError('A CREATE DATABASE statement did not create exactly one database.')
        current = created[0]!
        conn = await reconnect(conn, current)
        databases.push(current)
      } else if (section.hasStatements || sections.length === 1) {
        databases.push('postgres')
      }
      if (section.hasStatements) await runPart(conn, section.body, current === 'postgres' ? '' : ` (in ${current})`)
    }
    if (dataset.expectedTables.length > 0) {
      const res = await conn.query<{ t: string }>(`select t from unnest($1::text[]) as t where to_regclass(t) is null`, [
        dataset.expectedTables,
      ])
      if (res.rows.length > 0) {
        throw new SeedError(`The dataset is missing expected tables: ${res.rows.map((r) => r.t).join(', ')}`)
      }
    }
    await conn.exec(`comment on database postgres is ${quoteLiteral(DATASET_MARKER_PREFIX + dataset.id)}`)
    if ((await readDatasetMarker(conn)) !== dataset.id) throw new SeedError('The dataset marker could not be verified after loading.')
    return { db: conn, database: current, databases }
  } catch (err) {
    await conn.close().catch(() => {})
    throw err
  }
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}
