/**
 * UUIDv7 — time-ordered, so it indexes like a sequence but two offline terminals
 * can never mint the same id. Sequential integer keys would collide the first
 * time a shop runs a second register.
 *
 * Uses the Web Crypto global rather than node:crypto so the same code runs in the
 * webview and in Node without a bundler shim.
 */

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function newId(): string {
  const ts = BigInt(Date.now())
  const bytes = randomBytes(16)

  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* There was a `newDeviceId()` here, exported and called by nothing. A device
   identity is minted by `src-tauri/src/device.rs` and nowhere else — core is
   explicitly not allowed to mint one, because an id minted in the webview would
   have nowhere to live but the database, which is the one place it must never
   be. Two minters, one of them dead and contradicting the other's reason for
   existing, is worse than none. */

export function timestampOf(id: string): Date | null {
  const hex = id.replace(/-/g, '')
  if (hex.length !== 32) return null
  const ms = Number.parseInt(hex.slice(0, 12), 16)
  return Number.isFinite(ms) ? new Date(ms) : null
}
