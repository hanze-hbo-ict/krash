// Phase A spike: PGlite in a dedicated worker with per-session IndexedDB.
import { DbClient } from '../src/db/dbClient'
import { DEFAULT_DATASET } from '../src/db/defaultDataset'

const log = document.getElementById('log')!
const client = new DbClient()
const params = new URLSearchParams(location.search)
let session = sessionStorage.getItem('spike-session')
if (!session) {
  session = Math.random().toString(36).slice(2, 12).padEnd(10, '0')
  sessionStorage.setItem('spike-session', session)
}
const dbName = params.get('memory') ? null : `krash-${session}-1`
const dataset = DEFAULT_DATASET

declare global {
  interface Window {
    spike: { ready: Promise<unknown>; run: (sql: string) => Promise<unknown>; client: DbClient; dbName: string | null; session: string }
  }
}
const t0 = performance.now()
const ready = client.request({ type: 'init', dbName, dataset }).then((info) => {
  log.textContent = `ready in ${Math.round(performance.now() - t0)} ms\n${JSON.stringify(info, null, 2)}`
  return info
}, (err) => {
  log.textContent = `FAILED: ${JSON.stringify(err.failure ?? String(err))}`
  throw err
})
window.spike = {
  ready,
  run: (sql: string) => client.request({ type: 'execute', sql, maxRows: 1000 }),
  client,
  dbName,
  session,
}
