/**
 * Detects a second browser tab using the same session (e.g. "Duplicate tab"
 * copies sessionStorage). Two PGlite instances must never write the same
 * IndexedDB database, so the session holds a Web Lock for the page lifetime.
 *
 * On a normal reload the previous document releases its lock as it unloads;
 * we wait briefly to tolerate that hand-over.
 */
export type LockResult = 'acquired' | 'held-elsewhere' | 'unsupported'

export function acquireSessionLock(sessionId: string, waitMs = 2500): Promise<LockResult> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  if (!locks?.request) return Promise.resolve('unsupported')
  return new Promise<LockResult>((resolve) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), waitMs)
    locks
      .request(`krash-session-${sessionId}`, { signal: controller.signal }, () => {
        clearTimeout(timer)
        resolve('acquired')
        // Hold the lock until the page goes away.
        return new Promise<void>(() => {})
      })
      .catch((err: unknown) => {
        clearTimeout(timer)
        resolve((err as Error)?.name === 'AbortError' ? 'held-elsewhere' : 'unsupported')
      })
  })
}
