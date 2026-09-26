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

/* The last id minted, for `newId`'s ordering guarantee. */
let lastMs = -1n
let lastBytes: Uint8Array | null = null

/**
 * A new id, and one that sorts after every id this process minted before it.
 *
 * The timestamp alone does not give that: two ids in the same millisecond had
 * random tails, and so sorted in either order. The stock ledger is replayed in
 * id order -- the one order every till holding the same rows agrees on, which
 * local `rowid` is not -- so within a millisecond the next id is the last one
 * plus one (RFC 9562 section 6.2, method 2), and a clock that steps backwards
 * keeps the last timestamp rather than going back with it.
 */
export function newId(): string {
  let ts = BigInt(Date.now())
  let bytes: Uint8Array

  if (ts <= lastMs && lastBytes !== null && increment(lastBytes)) {
    ts = lastMs
    bytes = lastBytes
  } else {
    if (ts <= lastMs) ts = lastMs + 1n
    bytes = randomBytes(16)
  }
  lastMs = ts
  lastBytes = bytes.slice()

  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  lastBytes = bytes.slice()

  return format(bytes)
}

/** How far ahead of this machine's clock another till's id is believed. */
const OBSERVE_AHEAD_MS = 7n * 24n * 60n * 60n * 1000n

/**
 * Moves this process's id clock past an id minted elsewhere, so the next
 * `newId` sorts after it -- the receive step of a hybrid logical clock.
 *
 * A till whose clock runs ahead mints ids in this till's future. Anything
 * ordered by id then needs this till's next id to land after those, not
 * before; its wall clock alone would put it before. Ids that are not UUIDv7
 * are ignored, as are ones behind the clock already.
 */
export function observeId(id: string, now = Date.now()): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)) return
  const ms = BigInt(`0x${id.slice(0, 8)}${id.slice(9, 13)}`)
  /* Followed only within a week of this machine's clock. A till an hour or a
     day out is a shop PC with a flat CMOS battery, and ordering around it is
     the point; one stamped years ahead is broken, and following it would drag
     every id this till ever makes into that year for good. Past the bound the
     order is left to this clock, which costs at worst one product reported
     adrift until its next merge. */
  if (ms > BigInt(now) + OBSERVE_AHEAD_MS) return
  if (ms > lastMs) {
    lastMs = ms
    lastBytes = null
  }
}

/**
 * Adds one to the random part of an id in place: bytes 15 down to 9, then the
 * six free bits of byte 8. False when it would overflow into the variant bits,
 * which a caller answers by moving to the next millisecond.
 */
function increment(bytes: Uint8Array): boolean {
  for (let i = 15; i >= 9; i--) {
    const next = (bytes[i] ?? 0) + 1
    bytes[i] = next & 0xff
    if (next <= 0xff) return true
  }
  const low = ((bytes[8] ?? 0) & 0x3f) + 1
  if (low > 0x3f) return false
  bytes[8] = ((bytes[8] ?? 0) & 0xc0) | low
  return true
}

/* There was a `newDeviceId()` here, exported and called by nothing. A device
   identity is minted by `src-tauri/src/device.rs` and nowhere else — core is
   explicitly not allowed to mint one, because an id minted in the webview would
   have nowhere to live but the database, which is the one place it must never
   be. Two minters, one of them dead and contradicting the other's reason for
   existing, is worse than none. */

/**
 * The ShopOS namespace, for ids derived from what a row *is* rather than from
 * when it was made.
 *
 * Any constant would do, and it must be ShopOS's own rather than one of the four
 * the RFC reserves: the namespace is what keeps two *kinds* of derived id built
 * from the same words apart, and borrowing the URL or X.500 namespace would mean
 * sharing that space with everything else that ever borrowed it.
 *
 * Minted once and never changed. It is baked into every id derived under it, so
 * a new namespace would have two tills deriving two ids for one row, which is
 * the entire problem this exists to solve. A shop that has traded under the old
 * one would hold both.
 */
const SHOPOS_NAMESPACE = '5f0a3c21-7b64-4d8e-9a17-c3e6d2b84f09'

/**
 * An id two tills that have never met will independently agree on.
 *
 * `newId` is right for almost everything: a bill, a customer, a stock movement
 * are all things that happened once, somewhere, and the machine that recorded it
 * is entitled to name it. The exceptions are the rows that are not events but
 * *statements about a combination* — the price of this product on that list in
 * that unit at that quantity, the fact that this product comes in boxes of
 * twelve. Two counters offline can both make the same statement, and with
 * `newId` they make it under two ids. Nothing collides, nothing is refused, and
 * the shop ends up holding one fact twice, each copy with its own revision,
 * disagreeing forever about a rate nobody edited.
 *
 * So the id is the fact. Derive it from the combination and both tills write the
 * same row, the merge sees one record, and the later timestamp wins the way it
 * does for everything else.
 *
 * RFC 9562 version 5: SHA-1 of the namespace and the name, with the version and
 * variant bits set. Not for secrecy — SHA-1 is not being trusted here to resist
 * anybody, only to spread 128 bits evenly over inputs that are already ids and
 * short strings.
 *
 * **Only for keys that cannot be renamed.** A price list can be renamed and a
 * category can be renamed; deriving their ids from their names turns
 * rename-then-recreate into `UNIQUE constraint failed` in a shopkeeper's face,
 * on one till, with no sync involved. The four tables that use this are keyed by
 * structure — which product, which unit, which barcode — and structure is what
 * a row is rather than what it is called.
 */
export async function derivedId(...parts: Array<string | number>): Promise<string> {
  /* NUL between the parts, so `('AB', 'C')` and `('A', 'BC')` are different
     names. It cannot appear in a sale unit, a barcode or a UUID. */
  const name = parts.map(String).join('\u0000')
  const bytes = new Uint8Array(16 + new TextEncoder().encode(name).length)
  bytes.set(uuidBytes(SHOPOS_NAMESPACE), 0)
  bytes.set(new TextEncoder().encode(name), 16)

  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', bytes))
  const id = digest.slice(0, 16)
  id[6] = ((id[6] ?? 0) & 0x0f) | 0x50
  id[8] = ((id[8] ?? 0) & 0x3f) | 0x80
  return format(id)
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function format(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function timestampOf(id: string): Date | null {
  const hex = id.replace(/-/g, '')
  if (hex.length !== 32) return null
  const ms = Number.parseInt(hex.slice(0, 12), 16)
  return Number.isFinite(ms) ? new Date(ms) : null
}
