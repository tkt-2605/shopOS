/**
 * What a licence says, and whether it was really signed.
 *
 * Pure and database-free: a string goes in, a verdict comes out. The service
 * beside this stores it and answers what the shop is entitled to;
 * `apps/portal` mints them with the private half.
 *
 * ## The rule that outranks everything else here
 *
 * **A licence never stops a shop billing.** Not lapsed, not missing, not
 * forged, not when the clock is wrong and not when the portal has been
 * unreachable for a year. The counter works with the line down is the first
 * rule of this product, and a payment dispute is not a reason to stand between
 * a shopkeeper and a customer holding cash.
 *
 * So there is no `allowed: false` anywhere in this module for anything a till
 * does on its own. What a licence gates is the things that cost the vendor
 * money to run -- the cloud peer, the phone view, the diagnostics upload,
 * branches -- and those degrade to "not connected", which is a state the
 * product already has to handle on every LAN it has ever run on.
 *
 * ## The token
 *
 * `base64url(payload).base64url(signature)`, Ed25519 over the payload bytes
 * exactly as they appear before decoding. Not JWT: JWT's header carries the
 * algorithm, which means a verifier has to refuse to be told `none`, and the
 * list of ways that has gone wrong in other people's products is long. Here
 * the algorithm is Ed25519 because this file says so and there is nowhere to
 * write anything else.
 *
 * `kid` names the key that signed it, so a key can be rotated without every
 * till in the field being wrong at once: a build carries both the old and the
 * new until the last licence issued under the old one has expired.
 */

export const TIERS = ['single', 'multi', 'cloud', 'branches'] as const
export type Tier = (typeof TIERS)[number]

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value)
}

export interface LicenceToken {
  /** The shop this was issued to. Checked against `settings.shop_id` on install. */
  shopId: string
  tier: Tier
  /** A business date, `YYYY-MM-DD`. Null is a perpetual licence. */
  paidThrough: string | null
  /** How many tills the shop has paid for. Advisory — see `overTillLimit`. */
  tills: number
  /** ISO instant the portal signed it. */
  issuedAt: string
  /** Which signing key. */
  kid: string
}

/**
 * How long after `paidThrough` the paid-for things keep working.
 *
 * Thirty days rather than a week, on purpose. The failure this absorbs is a
 * shopkeeper whose renewal did not go through in a month where money was
 * tight, and taking their off-site backup away in that particular month is
 * both the cruellest timing available and the one most likely to lose
 * somebody's books.
 */
export const GRACE_DAYS = 30

export type VerifyFailure =
  /** Not two base64url parts, or the payload is not a licence shape. */
  | 'MALFORMED'
  /** Signed, but not by a key this build knows. An older till, or a forgery. */
  | 'UNKNOWN_KEY'
  /** The right key, and the signature does not check out. */
  | 'BAD_SIGNATURE'
  /** This build has no signing keys at all — see `config/licensing.ts`. */
  | 'NOT_CONFIGURED'

export type VerifyResult =
  | { ok: true; token: LicenceToken }
  | { ok: false; code: VerifyFailure }

/** A public key this build will accept a signature from, by `kid`. */
export interface SigningKey {
  kid: string
  /** The raw 32-byte Ed25519 public key, base64url. */
  publicKey: string
}

/**
 * Whether `raw` is a licence, signed by one of `keys`.
 *
 * Says nothing about whether it is *this* shop's or still paid for. Those are
 * separate questions with separate answers, because a token that is genuine
 * and expired needs different words at the counter from one that is not
 * genuine at all.
 */
export async function verifyToken(
  raw: string, keys: readonly SigningKey[],
): Promise<VerifyResult> {
  const parts = raw.trim().split('.')
  const [encodedPayload, encodedSignature] = parts
  if (parts.length !== 2 || encodedPayload === undefined || encodedSignature === undefined
      || encodedPayload === '' || encodedSignature === '') {
    return { ok: false, code: 'MALFORMED' }
  }

  let payloadBytes: Uint8Array
  let signature: Uint8Array
  try {
    payloadBytes = fromBase64Url(encodedPayload)
    signature = fromBase64Url(encodedSignature)
  } catch {
    return { ok: false, code: 'MALFORMED' }
  }

  const token = parsePayload(payloadBytes)
  if (token === null) return { ok: false, code: 'MALFORMED' }

  if (keys.length === 0) return { ok: false, code: 'NOT_CONFIGURED' }

  const key = keys.find((k) => k.kid === token.kid)
  if (key === undefined) return { ok: false, code: 'UNKNOWN_KEY' }

  /* The signature covers the base64url text's bytes, not the re-encoded JSON.
     Re-encoding would make the check depend on key order and on how this
     runtime spells a number, and two runtimes that disagree about either would
     reject each other's genuine licences. */
  const signed = new TextEncoder().encode(encodedPayload)

  let publicKey: VerifyingKey
  try {
    publicKey = await importPublicKey(key.publicKey)
  } catch {
    // A key this build ships that is not a key. Not the holder's fault, and
    // not something they can fix, but it is still not a verified licence.
    return { ok: false, code: 'NOT_CONFIGURED' }
  }

  const good = await subtle().verify({ name: 'Ed25519' }, publicKey, signature, signed)
  return good ? { ok: true, token } : { ok: false, code: 'BAD_SIGNATURE' }
}

/**
 * The payload without checking anything.
 *
 * For a diagnostics bundle and for the screen that has to say *why* a licence
 * was refused: "this code is for a different shop" needs the shop id out of a
 * token that was never going to be installed.
 */
export function readTokenUnverified(raw: string): LicenceToken | null {
  const first = raw.trim().split('.')[0]
  if (first === undefined || first === '') return null
  try {
    return parsePayload(fromBase64Url(first))
  } catch {
    return null
  }
}

export type LicenceState =
  /** Paid for, or perpetual. */
  | 'active'
  /** Past `paidThrough`, inside `GRACE_DAYS`. Everything still works. */
  | 'grace'
  /** Past the grace period. The paid-for services stop; the till does not. */
  | 'lapsed'
  /** No licence installed. Also a working till. */
  | 'none'

/**
 * Where a token stands on a given business day.
 *
 * Business dates, not instants: a licence paid through the 31st is good for
 * the whole of the 31st in the shop's own day, and comparing ISO timestamps
 * would end it at half past five in the morning for the same UTC reason
 * `businessDate()` exists.
 */
export function stateOf(
  token: LicenceToken | null, today: string, graceDays: number = GRACE_DAYS,
): { state: LicenceState; graceUntil: string | null } {
  if (token === null) return { state: 'none', graceUntil: null }
  if (token.paidThrough === null) return { state: 'active', graceUntil: null }

  const graceUntil = addBusinessDays(token.paidThrough, graceDays)
  if (today <= token.paidThrough) return { state: 'active', graceUntil }
  if (today <= graceUntil) return { state: 'grace', graceUntil }
  return { state: 'lapsed', graceUntil }
}

/**
 * The things a licence actually gates.
 *
 * The old test for belonging on this list was "it costs the vendor money per
 * shop per month". `multiTill` fails that test and is here anyway, which is a
 * deliberate change and is worth the paragraph.
 *
 * ## Why `multiTill` is on the list
 *
 * The four features below it are Phase 6 and Phase 7 and **none of them is
 * built**, so until now a licence gated nothing that existed — there was
 * literally no product to sell. A second counter is built, works, and is the
 * thing a shopkeeper can see the value of; off-site backup is a hard sell to a
 * one-counter chemist. It also prices by shop size, which is the intent.
 *
 * So the honest statement of the rule is now: **a licence gates what the
 * vendor chooses to sell, and never anything a shop needs to take money.** The
 * second half is the one that was never negotiable and still is not.
 *
 * ## What `multiTill` must never mean
 *
 * It gates **adding** a till, never **syncing** with one already added. That
 * distinction is the whole safety of it. Billing does not stop when a licence
 * lapses — it must not, it is the first rule — so a lapse that stopped sync
 * would leave a shop with two counters taking money that never merged, and
 * nobody would notice for weeks. Stock, credit and every report would be wrong
 * on both machines. That is far worse than an unpaid invoice.
 *
 * So the gate sits on the door, not the wire: `letThemIn` in `syncServer.ts`
 * and the "Add a till" button. `serveIfPaired`, `syncWith`, `handleFetch` and
 * `handleOffer` are never asked. A shop that lapses keeps every till it has,
 * working exactly as before, and simply cannot add the next one.
 */
export const GATED = [
  'multiTill', 'cloudPeer', 'phoneView', 'diagnosticsUpload', 'branches',
] as const
export type GatedFeature = (typeof GATED)[number]

const NEEDS: Record<GatedFeature, Tier> = {
  multiTill: 'multi',
  cloudPeer: 'cloud',
  phoneView: 'cloud',
  diagnosticsUpload: 'cloud',
  branches: 'branches',
}

/**
 * The ladder. A tier gets everything below it, so `cloud` includes
 * `multiTill`: a shop big enough to want its books off-site certainly has more
 * than one counter, and charging twice for that would read as sharp practice.
 */
const RANK: Record<Tier, number> = { single: 0, multi: 1, cloud: 2, branches: 3 }

/**
 * Whether a shop in this state may use a gated feature.
 *
 * `grace` says yes. That is the whole point of a grace period: the month the
 * renewal is late is not the month to stop copying somebody's books off-site.
 */
export function allows(
  entitlement: { tier: Tier; state: LicenceState }, feature: GatedFeature,
): boolean {
  if (entitlement.state === 'none' || entitlement.state === 'lapsed') return false
  return RANK[entitlement.tier] >= RANK[NEEDS[feature]]
}

/**
 * Whether the shop is running more tills than it has paid for.
 *
 * Returns the overage rather than a verdict, and nothing in the product
 * refuses anything because of it. A shop that adds a fourth counter on a
 * Saturday has not done something wrong; it has done something the vendor
 * would like to know about and invoice for on Monday. The screen says so
 * once, in a sentence, and sells nobody a broken Saturday.
 */
export function overTillLimit(token: LicenceToken | null, tillsInUse: number): number {
  if (token === null) return 0
  return Math.max(0, tillsInUse - token.tills)
}

/* ── the wire format ───────────────────────────────────────────────────── */

function parsePayload(bytes: Uint8Array): LicenceToken | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null

  const raw = value as Record<string, unknown>
  const { shopId, tier, paidThrough, tills, issuedAt, kid } = raw

  if (typeof shopId !== 'string' || shopId === '') return null
  if (typeof tier !== 'string' || !isTier(tier)) return null
  if (paidThrough !== null && !isBusinessDate(paidThrough)) return null
  if (typeof tills !== 'number' || !Number.isInteger(tills) || tills < 1) return null
  if (typeof issuedAt !== 'string' || issuedAt === '') return null
  if (typeof kid !== 'string' || kid === '') return null

  return { shopId, tier, paidThrough, tills, issuedAt, kid }
}

function isBusinessDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** `YYYY-MM-DD` plus whole days, staying in calendar terms and never in UTC. */
function addBusinessDays(date: string, days: number): string {
  const parts = date.split('-').map(Number)
  const [y = 1970, m = 1, d = 1] = parts
  const shifted = new Date(y, m - 1, d + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('not base64url')
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** The payload half of a token, which is what a signature is taken over. */
export function encodePayload(token: LicenceToken): string {
  /* Keys in a fixed order so that signing the same licence twice produces the
     same bytes. `JSON.stringify` follows insertion order, which is a promise
     about this object literal rather than about the input. */
  return toBase64Url(new TextEncoder().encode(JSON.stringify({
    shopId: token.shopId,
    tier: token.tier,
    paidThrough: token.paidThrough,
    tills: token.tills,
    issuedAt: token.issuedAt,
    kid: token.kid,
  })))
}

async function importPublicKey(base64url: string): Promise<VerifyingKey> {
  const bytes = fromBase64Url(base64url)
  if (bytes.length !== 32) throw new Error('an Ed25519 public key is 32 bytes')
  return subtle().importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify'])
}

/**
 * An imported public key, as an opaque handle.
 *
 * Declared here rather than taken from a `lib`, because this file is compiled
 * three ways -- core's node-typed config, the app's DOM-typed one, and the
 * portal's -- and only one of those has `CryptoKey` as a global. The two
 * methods below are the entire surface this module uses, so a structural type
 * costs nothing and removes a `lib` dependency from the one piece of business
 * logic that has to run everywhere.
 */
export interface VerifyingKey { readonly type: string }

interface Ed25519Subtle {
  importKey(
    format: 'raw', keyData: Uint8Array, algorithm: { name: 'Ed25519' },
    extractable: boolean, usages: string[],
  ): Promise<VerifyingKey>
  verify(
    algorithm: { name: 'Ed25519' }, key: VerifyingKey,
    signature: Uint8Array, data: Uint8Array,
  ): Promise<boolean>
}

/**
 * WebCrypto, from wherever this is running.
 *
 * `globalThis.crypto` in the webview, in Node 22 and in a worker. Reached
 * through a function rather than destructured at module load so that a test
 * environment which installs it late still works.
 *
 * Ed25519 in WebCrypto is supported by WebView2 and by Node 22, which is why
 * it is the signature algorithm: no dependency, on either side.
 */
function subtle(): Ed25519Subtle {
  const available = (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle
  if (available === undefined) {
    throw new Error('no WebCrypto here, so no licence can be verified')
  }
  return available as Ed25519Subtle
}
