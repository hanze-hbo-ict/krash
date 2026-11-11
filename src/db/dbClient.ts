/**
 * Main-thread client for the database worker. Every request gets a unique id;
 * only the matching response resolves it.
 *
 * Query cancellation: PostgreSQL's statement_timeout does not fire inside the
 * single-threaded WASM build (verified with PGlite 0.5.13), and a running
 * query cannot be interrupted from JS. "Stop" therefore terminates the worker;
 * the caller then re-opens the same IndexedDB database in a new worker.
 * Effects of the interrupted run (and any open transaction) are lost.
 */
import type { DbRequest, DbResponseMap, RequestEnvelope, ResponseEnvelope, WorkerFailure } from './protocol'

export class DbFailure extends Error {
  constructor(readonly failure: WorkerFailure) {
    super(failure.message)
    this.name = 'DbFailure'
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export type WorkerFactory = () => Worker

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module', name: 'krash-db' })

export class DbClient {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** Called when the worker dies outside of an explicit stop. */
  onCrash: ((failure: WorkerFailure) => void) | null = null

  constructor(private readonly factory: WorkerFactory = defaultFactory) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    let worker: Worker
    try {
      worker = this.factory()
    } catch (err) {
      return Promise.reject(
        new DbFailure({ kind: 'wasm', message: 'The database worker could not be started.', detail: String(err) }),
      )
    }
    this.worker = worker
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DbFailure({ kind: 'wasm', message: 'The database worker did not start in time.' }))
      }, 30_000)
      worker.onmessage = (event: MessageEvent<ResponseEnvelope>) => {
        const msg = event.data
        if (msg.id === 0) {
          clearTimeout(timer)
          resolve()
          return
        }
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.value)
        else {
          p.reject(new DbFailure(msg.failure))
          if (msg.failure.kind === 'crash') this.handleDeath(msg.failure, false)
        }
      }
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault()
        clearTimeout(timer)
        const failure: WorkerFailure = {
          kind: 'crash',
          message: 'The embedded PostgreSQL engine stopped unexpectedly.',
          detail: event.message || undefined,
        }
        reject(new DbFailure({ ...failure, kind: 'wasm', message: 'The database worker failed to load.' }))
        this.handleDeath(failure, true)
      }
    })
    return this.ready
  }

  private handleDeath(failure: WorkerFailure, notify: boolean): void {
    this.terminateWorker()
    for (const p of this.pending.values()) p.reject(new DbFailure(failure))
    this.pending.clear()
    if (notify || failure.kind === 'crash') this.onCrash?.(failure)
  }

  private terminateWorker(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
  }

  async request<K extends DbRequest['type']>(request: Extract<DbRequest, { type: K }>): Promise<DbResponseMap[K]> {
    await this.start()
    const worker = this.worker
    if (!worker) throw new DbFailure({ kind: 'crash', message: 'The database worker is not running.' })
    const id = this.nextId++
    return new Promise<DbResponseMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const envelope: RequestEnvelope = { id, request }
      worker.postMessage(envelope)
    })
  }

  /** Hard stop: kills the worker and fails outstanding requests with kind "cancelled". */
  stop(): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.terminateWorker()
    for (const p of pending) p.reject(new DbFailure({ kind: 'cancelled', message: 'Stopped.' }))
  }

  dispose(): void {
    this.stop()
  }
}
