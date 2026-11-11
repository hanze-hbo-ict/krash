/** Random lower-case id (base36), from crypto when available. */
export function randomId(length = 16): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}
