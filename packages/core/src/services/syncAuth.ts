/**
 * Proving a request really came from the till it claims to be.
 *
 * Two tills that have paired share a secret. Every request afterwards carries a
 * signature made with it over the whole request — who, when, once, and the exact
 * bytes of the body — and every answer carries one over its status and body,
 * tied to the request it answers. **The secret never travels at all**: pairing
 * agrees it by ECDH (`pairingKey`, `agreeSecret`), each till deriving it from
 * its own private key and the other's public one, so somebody listening on the
 * shop's wifi while two tills pair learns two public keys and nothing else.
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

import { clock } from '../clock.js'

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const

/** How far apart two tills' clocks may be before a request is refused. */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000

/**
 * This machine's own certificate fingerprint, when it has one.
 *
 * Null today on every build, because nothing here serves TLS and this file
 * argues at length that on a shop's own wire it should not have to. What is
 * coming is a cloud peer over the internet and a phone that will not open a
 * cleartext socket at all, and the answer to both is Syncthing's: the device id
 * *is* the fingerprint, swapped once at pairing, with no authority and nothing
 * to renew.
 *
 * A source rather than a value, for the same reason as `setDeviceIdSource` — a
 * certificate belongs to whatever is holding the socket, which is Rust in the
 * app and nothing at all in a test. Core never mints one.
 *
 * It exists now, unread, because pairing is the only exchange two tills have
 * before they trust each other, a shop performs it once by hand, and a build
 * that adds the field later cannot ask a shop to re-pair every till it owns.
 * Migration 047 carries the rest of the argument.
 */
let fingerprintSource: (() => string | null) | null = null

export function setFingerprintSource(fn: (() => string | null) | null): void {
  fingerprintSource = fn
}

export function myFingerprint(): string | null {
  return fingerprintSource ? fingerprintSource() : null
}

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
  /* The secret and nonce come back so the answer can be signed with them. */
  | { ok: true; deviceId: string; nonce: string; secret: string }
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
  now = clock.now(),
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
 * a timestamp is accepted in, and a table would be one more thing to write on
 * every single request.
 *
 * What that leaves, said plainly: a restart forgets them, and a request
 * captured in the five minutes before it can be sent again afterwards. It is
 * accepted because a replay changes nothing. `/hello` only reads. `/fetch`
 * moves a cursor forwards and never back. `/offer` carries rows the merge has
 * already decided on -- an older copy loses to what is here and writes nothing
 * -- and moves a cursor forwards only. `replayAfterRestart.test.ts` holds that
 * to be true, because the day an endpoint stops being idempotent is the day
 * this needs a table.
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
  now = clock.now(),
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

  return { ok: true, deviceId: signed.deviceId, nonce: signed.nonce, secret }
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

/* ------------------------------------------------------------ answers --- */

/**
 * The signature on an answer.
 *
 * Requests were signed and answers were not, so anybody able to sit in the
 * middle of the shop's wifi -- one poisoned ARP table -- could hand a till a
 * batch of rows the other till never sent. The answer is signed with the same
 * secret over its status and body, and over the nonce of the request it
 * answers, so an answer cannot be replayed against a different request.
 */
export async function signReply(secret: string, nonce: string, status: number, body: string): Promise<string> {
  return hmac(secret, `reply\n${nonce}\n${status}\n${body}`)
}

export async function replyIsGenuine(
  secret: string, nonce: string, status: number, body: string, mac: string,
): Promise<boolean> {
  return sameString(await signReply(secret, nonce, status, body), mac)
}

/* ------------------------------------------------------------ pairing --- */

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

/* The key type, taken from the API rather than named: core is built without the
   DOM's type library, and node's lives behind an import this file does not make. */
type Key = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>

/** A key pair for one pairing, and its public half as it travels. */
export interface PairingKey {
  publicKey: string
  privateKey: Key
}

/**
 * A fresh key pair, used for one pairing and thrown away.
 *
 * P-256 because it is the curve WebCrypto offers everywhere this runs -- the
 * webview, node, and the phone that is coming -- and the private half is
 * created unextractable, so it cannot leave this process even by accident.
 */
export async function pairingKey(): Promise<PairingKey> {
  const pair = await globalThis.crypto.subtle.generateKey(ECDH, false, ['deriveBits']) as { publicKey: Key; privateKey: Key }
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  return { publicKey: hex(raw), privateKey: pair.privateKey }
}

/** Whether a string is a public key as `pairingKey` writes one: 65 bytes, uncompressed. */
export function isPairingPublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^04[0-9a-f]{128}$/.test(value)
}

/**
 * The secret two tills will share, worked out on each side from its own
 * private key and the other's public key.
 *
 * ECDH, then HKDF-SHA-256 over both public keys in a fixed order -- the joining
 * till's first -- so the result is bound to this exchange and cannot be moved
 * to another. Hex, the same shape `mintSecret` produced, so nothing downstream
 * can tell how it was made.
 */
export async function agreeSecret(
  mine: PairingKey, theirs: string, joinerKey: string, hostKey: string,
): Promise<string> {
  const theirKey = await globalThis.crypto.subtle.importKey('raw', unhex(theirs), ECDH, false, [])
  const shared = await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: theirKey }, mine.privateKey, 256)
  const hkdfKey = await globalThis.crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new TextEncoder().encode(`${joinerKey}|${hostKey}`),
      info: new TextEncoder().encode('shopos sync secret v1'),
    },
    hkdfKey, 256,
  )
  return hex(new Uint8Array(bits))
}

/**
 * The digits a person compares on the two screens, from both public keys.
 *
 * They used to be two random digits, honest about proving nothing. Taken from
 * the keys, they prove the thing that matters: a machine in the middle has to
 * swap in keys of its own, and then the two screens show different numbers.
 * Six digits. Four were said to make a machine in the middle win once in ten
 * thousand tries, each one a shopkeeper pressing Refuse -- which is not so: it
 * sees the joining till's key before it has to choose the one it shows that
 * till, so it can try keys offline until the digits match, and ten thousand
 * key pairs is a moment's work. Six makes that a million, and the wall is
 * `keyCommitment`: the joining till is bound to its key before it sees the
 * shop's, so neither side's key can be chosen to fit, and a machine in the
 * middle is left with one guess in a million per attempt -- each attempt a
 * shopkeeper looking at two numbers that do not match.
 */
/**
 * What a joining till sends before its key: a SHA-256 of it.
 *
 * The digits a person compares only prove anything if neither side could pick
 * its key after seeing the other's. The joining till used to send its key
 * first, so a machine in the middle -- posing as the shop -- saw it before
 * choosing the key it showed back, and could try keys until the digits
 * matched. Now the joining till sends this, hears the shop's key, and only then
 * shows its own, which the shop checks against this. Bluetooth's numeric
 * comparison and ZRTP do the same thing for the same reason.
 */
/**
 * A key made from a pairing code, slowly.
 *
 * The typed code used to cross the wire as it was typed, beside the joining
 * till's key -- so a machine in the middle could read it and relay the whole
 * request with a key of its own. Now the code never crosses: each side proves
 * it knows it with an HMAC over the keys, and neither proof can be moved to a
 * different key.
 *
 * Slowly, because a proof is something to guess against. Eight characters from
 * thirty-two is forty bits, which a fast hash gives up to one graphics card in
 * minutes; a hundred thousand rounds of PBKDF2 makes that years, against a code
 * that is spent on the first attempt and gone in ten minutes. Salted with the
 * joining till's id, so no two pairings share a table.
 */
export const CODE_ROUNDS = 100_000

async function codeKey(code: string, joiner: string): Promise<Key> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(code.trim().toUpperCase()), 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2', hash: 'SHA-256', iterations: CODE_ROUNDS,
      salt: new TextEncoder().encode(`shopos pairing code|${joiner}`),
    },
    material, 256,
  )
  return globalThis.crypto.subtle.importKey('raw', bits, ALGORITHM, false, ['sign'])
}

async function macWith(key: Key, message: string): Promise<string> {
  return hex(new Uint8Array(await globalThis.crypto.subtle.sign(ALGORITHM.name, key, new TextEncoder().encode(message))))
}

/** The joining till's proof that it was read the code, bound to its key. */
export async function codeProof(code: string, joiner: string, joinerKey: string): Promise<string> {
  return macWith(await codeKey(code, joiner), `join\n${joinerKey}`)
}

/**
 * The shop's answer to it: that it knows the code too, bound to both keys. A
 * machine in the middle that swapped either key cannot make this, so the
 * joining till checks it before it trusts the key it was handed.
 */
export async function codeConfirmation(
  code: string, joiner: string, joinerKey: string, hostKey: string,
): Promise<string> {
  return macWith(await codeKey(code, joiner), `shop\n${joinerKey}\n${hostKey}`)
}

export async function keyCommitment(publicKey: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey))
  return hex(new Uint8Array(digest))
}

export function isKeyCommitment(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export async function comparisonDigits(joinerKey: string, hostKey: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${joinerKey}|${hostKey}`),
  ))
  const n = ((digest[0]! << 24) >>> 0) + (digest[1]! << 16) + (digest[2]! << 8) + digest[3]!
  return String(n % 1_000_000).padStart(6, '0')
}

function unhex(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(text.length / 2))
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
