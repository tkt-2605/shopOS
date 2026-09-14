/**
 * Proving a request really came from the till it claims to be.
 *
 * Two tills that have paired share a secret. Every request afterwards carries a
 * signature made with it over the whole request — who, when, once, and the exact
 * bytes of the body — and **the secret itself never travels again**. Somebody
 * listening on the shop's wifi cannot lift it from a request, and cannot change
 * a request without the signature failing.
 *
 * What this does not do is hide anything. The bills cross the LAN in clear.
 * That is stated here and in `docs/multi-device.md` rather than implied away,
 * because the gap between "signed" and "private" is exactly the kind a person
 * assumes closed. TLS between two tills means certificates nobody can check,
 * pinned by hand, expiring in a shop with no IT — the right next step, not this
 * one.
 *
 * WebCrypto rather than a library: it is in the webview and in node, it is the
 * one piece of cryptography worth not writing, and a dependency here would be a
 * dependency in the part of the product that decides who may read the shop's
 * sales.
 */

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const

/** How far apart two tills' clocks may be before a request is refused. */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000

export interface SignedRequest {
  deviceId: string
  timestamp: number
  nonce: string
  signature: string
}

export type AuthFailure =
  | 'MALFORMED'
  | 'UNKNOWN_PEER'
  | 'BAD_SIGNATURE'
  | 'STALE'
  | 'REPLAYED'

export type AuthResult =
  | { ok: true; deviceId: string }
  | { ok: false; code: AuthFailure }

/** A new shared secret. 32 bytes, which is the whole of the security here. */
export function mintSecret(): string {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * The code a person reads off one screen and types into another.
 *
 * Short, because it is typed by hand — and short is only safe because it lives
 * for minutes, is used once, and every wrong guess burns it. Eight characters
 * from an alphabet with no O/0 or I/1 to misread.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function mintPairingCode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

/**
 * What gets signed: everything that decides what the request does.
 *
 * The body is in it, so a batch cannot be altered on the way. The path is in it,
 * so a signature for `fetch` cannot be replayed against `offer`. The timestamp
 * and the nonce are in it, so a captured request cannot be sent twice.
 */
function subject(path: string, timestamp: number, nonce: string, body: string): string {
  return `${path}\n${timestamp}\n${nonce}\n${body}`
}

export async function sign(
  secret: string,
  deviceId: string,
  path: string,
  body: string,
  now = Date.now(),
): Promise<SignedRequest> {
  const nonce = hex(globalThis.crypto.getRandomValues(new Uint8Array(12)))
  const signature = await hmac(secret, subject(path, now, nonce, body))
  return { deviceId, timestamp: now, nonce, signature }
}

/** The header the signature travels in, and the reverse of it. */
export function encodeAuth(signed: SignedRequest): string {
  return [signed.deviceId, signed.timestamp, signed.nonce, signed.signature].join('.')
}

export function decodeAuth(header: string | null | undefined): SignedRequest | null {
  if (typeof header !== 'string') return null
  const parts = header.split('.')
  if (parts.length !== 4) return null
  const [deviceId, timestamp, nonce, signature] = parts as [string, string, string, string]
  const at = Number(timestamp)
  if (!Number.isFinite(at) || deviceId === '' || nonce === '' || signature === '') return null
  return { deviceId, timestamp: at, nonce, signature }
}

/**
 * Nonces already seen, so a captured request cannot be sent a second time.
 *
 * In memory and not in the database on purpose. It only has to cover the window
 * a timestamp is accepted in, a restart makes every old request stale anyway,
 * and a table would be one more thing to write on every single request.
 */
const seen = new Map<string, number>()

function rememberNonce(key: string, now: number): boolean {
  for (const [k, at] of seen) {
    if (now - at > CLOCK_TOLERANCE_MS * 2) seen.delete(k)
  }
  if (seen.has(key)) return false
  seen.set(key, now)
  return true
}

/** Only for tests, which need a clean window between cases. */
export function forgetNonces(): void {
  seen.clear()
}

export async function verify(
  header: string | null | undefined,
  path: string,
  body: string,
  secretFor: (deviceId: string) => Promise<string | null>,
  now = Date.now(),
): Promise<AuthResult> {
  const signed = decodeAuth(header)
  if (signed === null) return { ok: false, code: 'MALFORMED' }

  /* Before the secret is looked up, so an unpaired caller cannot use the timing
     of this to work out which tills a shop has. */
  if (Math.abs(now - signed.timestamp) > CLOCK_TOLERANCE_MS) {
    return { ok: false, code: 'STALE' }
  }

  const secret = await secretFor(signed.deviceId)
  if (secret === null) return { ok: false, code: 'UNKNOWN_PEER' }

  const expected = await hmac(secret, subject(path, signed.timestamp, signed.nonce, body))
  if (!sameString(expected, signed.signature)) return { ok: false, code: 'BAD_SIGNATURE' }

  /* Last, so that a wrong signature cannot be used to fill the table of nonces,
     and so a replay is only recorded once it is known to be a real request. */
  if (!rememberNonce(`${signed.deviceId}.${signed.nonce}`, now)) {
    return { ok: false, code: 'REPLAYED' }
  }

  return { ok: true, deviceId: signed.deviceId }
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), ALGORITHM, false, ['sign'],
  )
  const signature = await globalThis.crypto.subtle.sign(
    ALGORITHM.name, key, new TextEncoder().encode(message),
  )
  return hex(new Uint8Array(signature))
}

/**
 * Comparison that takes the same time whether the first character is wrong or
 * the last one is.
 *
 * `a === b` stops at the first difference, and the difference in how long that
 * takes is enough, given enough tries, to work out a signature one character at
 * a time. It is a small risk on a shop's LAN and a free thing to remove.
 */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let differences = 0
  for (let i = 0; i < a.length; i += 1) {
    differences |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return differences === 0
}

/** Exported for the pairing code, which is compared the same way. */
export const constantTimeEquals = sameString

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
