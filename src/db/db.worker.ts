/// <reference lib="webworker" />
/**
 * Dedicated worker that owns the single PGlite instance of this browser tab.
 * Requests are processed strictly one at a time, in arrival order.
 */
import { PGlite } from '@electric-sql/pglite'
import {
  executeScript,
  hasUserRelations,
  introspectSchema,
  quoteIdent,
  readDatasetMarker,
  SeedError,
  seedDatabase,
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

async function open(name: string | null): Promise<PGlite> {
  if (name !== null && typeof indexedDB === 'undefined') {
    throw new Failure('storage', 'IndexedDB is not available in this browser context.')
  }
  const startupFailed = new Promise<never>((_, reject) => {
    failStartup = reject
  })
  try {
    // relaxedDurability stays off: every query waits for the IndexedDB flush.
    return await Promise.race([PGlite.create(name ? { dataDir: `idb://${name}`, relaxedDurability: false } : {}), startupFailed])
  } catch (err) {
    const c = classify(err, 'storage')
    throw new Failure(c.kind, c.kind === 'wasm' ? c.message : 'The database could not be opened.', String((err as Error)?.message ?? err))
  } finally {
    failStartup = null
  }
}

async function info(instance: PGlite, dataset: DatasetSpec, seeded: boolean, mismatch: string | null, name: string | null): Promise<DbInfo> {
  const res = await instance.query<{ v: string; sv: string }>(`select version() as v, current_setting('server_version') as sv`)
  const v = res.rows[0]?.v ?? ''
  return {
    postgresVersion: res.rows[0]?.sv ?? 'unknown',
    pgliteVersion: /PGlite ([\d.]+)/.exec(v)?.[1] ?? 'unknown',
    datasetId: dataset.id,
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

/** Open (or create) `name`, seeding it only if it is brand new. */
async function openSeeded(name: string | null, dataset: DatasetSpec, allowReuse: boolean): Promise<{ instance: PGlite; info: DbInfo }> {
  const instance = await open(name)
  try {
    const marker = await readDatasetMarker(instance)
    if (allowReuse && marker === dataset.id) {
      return { instance, info: await info(instance, dataset, false, null, name) }
    }
    if (marker === null && !(await hasUserRelations(instance))) {
      await seedDatabase(instance, dataset.sql, dataset.id, dataset.expectedTables)
      return { instance, info: await info(instance, dataset, true, null, name) }
    }
    // An existing database from another dataset (or a half-loaded one). Never
    // destroy it silently; the UI offers an explicit reset.
    return { instance, info: await info(instance, dataset, false, marker ?? 'unknown', name) }
  } catch (err) {
    await instance.close().catch(() => {})
    // A brand-new database that failed to seed is useless; remove it.
    if (name && err instanceof SeedError) await deleteIdb(name)
    throw err
  }
}

async function handle(req: DbRequest): Promise<unknown> {
  switch (req.type) {
    case 'health':
      return { state: db ? (busy ? 'busy' : 'ready') : 'uninitialized' }
    case 'init': {
      if (db) await db.close().catch(() => {})
      db = null
      const { instance, info } = await openSeeded(req.dbName, req.dataset, true)
      db = instance
      dbName = req.dbName
      return info
    }
    case 'createFresh': {
      // Build and validate the new database first; swap only on success.
      if (req.dbName !== null && req.dbName === dbName) throw new Failure('internal', 'A fresh database needs a new name.')
      const { instance, info } = await openSeeded(req.dbName, req.dataset, false)
      if (info.datasetMismatch !== null) {
        await instance.close().catch(() => {})
        throw new Failure('seed', 'The new database was not empty; it was not used.')
      }
      const old = db
      db = instance
      dbName = req.dbName
      if (old) await old.close().catch(() => {})
      return info
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
    case 'previewTable': {
      const instance = requireDb()
      const limit = Math.max(1, Math.min(100, Math.floor(req.limit)))
      return executeScript(instance, `select * from ${quoteIdent(req.schema)}.${quoteIdent(req.table)} limit ${limit}`, {
        maxRows: limit,
      })
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
