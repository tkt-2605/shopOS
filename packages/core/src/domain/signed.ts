import { describeCause, fromBase64Url, verifyEd25519, type SigningKey } from './licence.js'

/*
 * Something the vendor signed: base64url JSON, a dot, and an Ed25519
 * signature over the first part's text -- the licence's shape, used for
 * everything else a till takes from the vendor on trust (`repairPack.ts`,
 * `switches.ts`). The payload names the key that signed it in `kid`.
 *
 * Says only whether the vendor signed it. What it says, and whether that is
 * for this shop and still in date, is the caller's.
 *
 * Pure and DB-free.
 */

export type SignedFailure = 'MALFORMED' | 'NOT_CONFIGURED' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE'

export type Signed =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: SignedFailure; cause?: string }

export async function verifySigned(raw: string, keys: readonly SigningKey[], whose: string): Promise<Signed> {
  const payload = readUnverified(raw)
  const sig = raw.trim().split('.')[1]
  if (payload === null || !sig) return { ok: false, code: 'MALFORMED' }

  let signature: Uint8Array
  try {
    signature = fromBase64Url(sig)
  } catch {
    return { ok: false, code: 'MALFORMED' }
  }

  if (keys.length === 0) return { ok: false, code: 'NOT_CONFIGURED', cause: `no keys in ${whose}` }
  const key = keys.find((k) => k.kid === payload['kid'])
  if (key === undefined) return { ok: false, code: 'UNKNOWN_KEY' }

  try {
    const good = await verifyEd25519(new TextEncoder().encode(raw.trim().split('.')[0]!), signature, key.publicKey)
    return good ? { ok: true, payload } : { ok: false, code: 'BAD_SIGNATURE' }
  } catch (e) {
    return { ok: false, code: 'NOT_CONFIGURED', cause: describeCause(e) }
  }
}

/** The payload without checking the signature, for saying why something was refused. */
export function readUnverified(raw: string): Record<string, unknown> | null {
  const parts = raw.trim().split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { kid?: unknown }).kid === 'string'
      ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}
