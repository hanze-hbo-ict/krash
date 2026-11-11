/// <reference lib="webworker" />
/**
 * Dedicated worker that owns the single PGlite instance of this browser tab.
 * Requests are processed strictly one at a time, in arrival order.
 */
import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import {
  executeScript,
  hasUserRelations,
  introspectSchema,
  buildDatabases,
  listDatabases,
  readDatasetMarker,
  SeedError,
  type Reconnect,
} from './engine'
import type {
  DatasetSpec,
  DbInfo,
  DbRequest,
  FailureKind,
  RequestEnvelope,
  ResponseEnvelope,
  WorkerFailure,
} from './protocol'
import { idbNameFor } from './storageNames'

declare const self: DedicatedWorkerGlobalScope

let db: PGlite | null = null
let dbName: string | null = null
let datasetId = ''
let busy = false
let queue: Promise<void> = Promise.resolve()

class Failure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}

function classify(err: unknown, fallback: FailureKind): WorkerFailure {
  if (err instanceof Failure) return { kind: err.kind, message: err.message, detail: err.detail }
  if (err instanceof SeedError) return { kind: 'seed', message: err.message }
  const e = err as { name?: string; message?: string; status?: number } | undefined
  const name = e?.name ?? ''
  const message = e?.message ?? String(err)
  if (name === 'ExitStatus' || name === 'RuntimeError' || /unreachable|memory access out of bounds|Aborted\(/i.test(message)) {
    return { kind: 'crash', message: 'The embedded PostgreSQL engine stopped unexpectedly.', detail: `${name}: ${message}` }
  }
  if (/wasm|WebAssembly|\.data|fetch|NetworkError|Failed to fetch|Load failed/i.test(message) && fallback !== 'sql') {
    return { kind: 'wasm', message: 'The PostgreSQL engine files could not be loaded.', detail: message }
  }
  if (/IndexedDB|IDB|QuotaExceeded|quota|storage/i.test(`${name} ${message}`)) {
    return { kind: 'storage', message: 'Browser storage for the database is unavailable or full.', detail: `${name}: ${message}` }
  }
  return { kind: fallback, message: message || 'Unknown error', detail: name || undefined }
}

/**
 * While PGlite starts, some loading failures (e.g. a missing .wasm file) surface
 * only as unhandled rejections and PGlite.create() never settles. Route those
 * to the pending start-up so the UI gets a real error instead of hanging.
 */
let failStartup: ((reason: unknown) => void) | null = null
self.addEventListener('unhandledrejection', (event) => {
  if (failStartup) {
    event.preventDefault()
    failStartup(event.reason)
  }
})
self.addEventListener('error', (event) => {
  if (failStartup) {
    event.preventDefault()
    failStartup(event.error ?? new Error(event.message))
  }
})

/** Create a PGlite instance, routing start-up failures that only surface as unhandled rejections. */
async function createPg(options: PGliteOptions): Promise<PGlite> {
  const startupFailed = new Promise<never>((_, reject) => {
    failStartup = reject
  })
  try {
    return await Promise.race([PGlite.create(options), startupFailed])
  } finally {
    failStartup = null
  }
}

/** Open the cluster `name` (IndexedDB) or a new in-memory one, connected to `database`. */
async function open(name: string | null, database = 'postgres'): Promise<PGlite> {
  if (name !== null && typeof indexedDB === 'undefined') {
    throw new Failure('storage', 'IndexedDB is not available in this browser context.')
  }
  if (name === null && database !== 'postgres') throw new Failure('internal', 'A temporary database can only be reconnected, not reopened.')
  try {
    // relaxedDurability stays off: every query waits for the IndexedDB flush.
    const options: PGliteOptions = name ? { dataDir: `idb://${name}`, relaxedDurability: false } : {}
    if (database !== 'postgres') options.database = database
    return await createPg(options)
  } catch (err) {
    const c = classify(err, 'storage')
    throw new Failure(c.kind, c.kind === 'wasm' ? c.message : 'The database could not be opened.', String((err as Error)?.message ?? err))
  }
}

/**
 * Like psql's \c: connect the same cluster to another database. PGlite has one
 * connection per instance, so the instance is closed and reopened. A temporary
 * (in-memory) cluster is copied to the new instance first.
 */
function reconnectFor(name: string | null): Reconnect {
  return async (instance, database) => {
    if (name) {
      await instance.close()
      return open(name, database)
    }
    const dump = await instance.dumpDataDir('none')
    await instance.close()
    return createPg({ loadDataDir: dump, database })
  }
}

async function currentDatabase(instance: PGlite): Promise<string> {
  return (await instance.query<{ d: string }>(`select current_database() as d`)).rows[0]?.d ?? 'postgres'
}

async function info(
  instance: PGlite,
  datasetIdValue: string,
  seeded: boolean,
  mismatch: string | null,
  name: string | null,
  databases: string[] | null,
): Promise<DbInfo> {
  const res = await instance.query<{ v: string; sv: string }>(`select version() as v, current_setting('server_version') as sv`)
  const v = res.rows[0]?.v ?? ''
  return {
    postgresVersion: res.rows[0]?.sv ?? 'unknown',
    pgliteVersion: /PGlite ([\d.]+)/.exec(v)?.[1] ?? 'unknown',
    datasetId: datasetIdValue,
    database: await currentDatabase(instance),
    databases,
    seeded,
    datasetMismatch: mismatch,
    persistent: name !== null,
  }
}

function deleteIdb(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(false)
    const req = indexedDB.deleteDatabase(idbNameFor(name))
    req.onsuccess = () => resolve(true)
    req.onerror = () => resolve(false)
    req.onblocked = () => resolve(false)
  })
}

/** Build the dataset on a brand-new cluster that `instance` is connected to (as postgres). */
async function build(instance: PGlite, name: string | null, dataset: DatasetSpec): Promise<{ instance: PGlite; info: DbInfo }> {
  try {
    const result = await buildDatabases(instance, dataset, reconnectFor(name))
    return { instance: result.db, info: await info(result.db, dataset.id, true, null, name, result.databases) }
  } catch (err) {
    // A brand-new cluster that failed to load is useless; remove it.
    if (name && err instanceof SeedError) await deleteIdb(name)
    throw err
  }
}

async function isEmptyCluster(instance: PGlite): Promise<boolean> {
  return (
    (await readDatasetMarker(instance)) === null &&
    (await listDatabases(instance)).length === 1 &&
    !(await hasUserRelations(instance))
  )
}

/**
 * Reopen `name` connected to `connectTo` (falling back to postgres if that
 * database no longer exists), or build the dataset if the cluster is new.
 */
async function openOrBuild(name: string | null, dataset: DatasetSpec, connectTo: string | null): Promise<{ instance: PGlite; info: DbInfo }> {
  if (name === null) return build(await open(null), null, dataset)
  let instance: PGlite
  try {
    instance = await open(name, connectTo ?? 'postgres')
  } catch (err) {
    if (!connectTo || connectTo === 'postgres') throw err
    instance = await open(name, 'postgres')
  }
  try {
    const marker = await readDatasetMarker(instance)
    if (marker === dataset.id) return { instance, info: await info(instance, dataset.id, false, null, name, null) }
    if (!(await isEmptyCluster(instance))) {
      // Another dataset (or a half-loaded one). Never destroy it silently; Reset is explicit.
      return { instance, info: await info(instance, dataset.id, false, marker ?? 'unknown', name, null) }
    }
  } catch (err) {
    await instance.close().catch(() => {})
    throw err
  }
  return build(instance, name, dataset)
}

async function handle(req: DbRequest): Promise<unknown> {
  switch (req.type) {
    case 'health':
      return { state: db ? (busy ? 'busy' : 'ready') : 'uninitialized' }
    case 'init': {
      if (db) await db.close().catch(() => {})
      db = null
      const { instance, info } = await openOrBuild(req.dbName, req.dataset, req.database)
      db = instance
      dbName = req.dbName
      datasetId = req.dataset.id
      return info
    }
    case 'createFresh': {
      // Build and validate the new cluster first; swap only on success.
      if (req.dbName !== null && req.dbName === dbName) throw new Failure('internal', 'A fresh database needs a new name.')
      const fresh = await open(req.dbName)
      if (!(await isEmptyCluster(fresh).catch(() => false))) {
        await fresh.close().catch(() => {})
        throw new Failure('seed', 'The new database was not empty; it was not used.')
      }
      const { instance, info } = await build(fresh, req.dbName, req.dataset)
      const old = db
      db = instance
      dbName = req.dbName
      datasetId = req.dataset.id
      if (old) await old.close().catch(() => {})
      return info
    }
    case 'connect': {
      const instance = requireDb()
      const previous = await currentDatabase(instance)
      if (!(await listDatabases(instance)).includes(req.database)) {
        throw new Failure('internal', `The database “${req.database}” does not exist.`)
      }
      db = null
      try {
        db = await reconnectFor(dbName)(instance, req.database)
      } catch (err) {
        // Try to get back to where we were (only possible with persistent storage).
        if (dbName) db = await open(dbName, previous).catch(() => null)
        throw err
      }
      return info(db, datasetId, false, null, dbName, null)
    }
    case 'dropDatabase': {
      if (req.dbName === dbName) throw new Failure('internal', 'Refusing to delete the database that is in use.')
      return { dropped: await deleteIdb(req.dbName) }
    }
    case 'close': {
      if (db) await db.close().catch(() => {})
      db = null
      dbName = null
      return { closed: true }
    }
    case 'execute': {
      const instance = requireDb()
      return executeScript(instance, req.sql, { maxRows: req.maxRows })
    }
    case 'getSchema': {
      // Inside an aborted transaction block this fails; the UI keeps the previous tree.
      return introspectSchema(requireDb())
    }
  }
}

function requireDb(): PGlite {
  if (!db) throw new Failure('internal', 'The database is not initialised.')
  return db
}

self.onmessage = (event: MessageEvent<RequestEnvelope>) => {
  const { id, request } = event.data
  queue = queue.then(async () => {
    busy = true
    let response: ResponseEnvelope
    try {
      response = { id, ok: true, value: await handle(request) }
    } catch (err) {
      const failure = classify(err, request.type === 'execute' ? 'internal' : request.type === 'init' ? 'storage' : 'internal')
      if (failure.kind === 'crash') db = null
      response = { id, ok: false, failure }
    } finally {
      busy = false
    }
    self.postMessage(response)
  })
}

self.postMessage({ id: 0, ok: true, value: 'worker-ready' } satisfies ResponseEnvelope)
