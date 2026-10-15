import { describeCause, fromBase64Url, verifyEd25519, type SigningKey } from './licence.js'

/*
 * A repair pack: a fix support made for one shop, signed so a till can tell
 * it came from the vendor and was not changed on the way.
 *
 * The same shape as a licence -- base64url JSON, a dot, base64url Ed25519
 * signature over the first part's text -- signed with the vendor's repair key
 * (`config/repairs.ts`). It names one shop, ends on a date, and is used once
 * for the whole shop. What it can do is a fixed list: each repair here is a
 * named operation in `services/repair.ts` with a preview and tests, never a
 * statement written for the occasion, so a pack cannot do anything this build
 * does not already know how to do safely.
 *
 * Pure and DB-free.
 */

export const PACK_FORMAT = 1

export type Repair =
  /** Every reconciler, or one, with repair on: cached figures set from their records. */
  | { kind: 'reconcile'; what: 'all' | 'stock' | 'returned' | 'fulfilled' | 'loyalty' | 'reversals' }
  /** Records sync set aside, tried again the way a merge tries them. */
  | { kind: 'retry_set_aside' }
  /** A counter held by a till that is gone for good, let go. */
  | { kind: 'free_counter'; registerId: string }
  /** A counter's next number moved past one another till already issued. */
  | { kind: 'renumber_from'; docType: string; prefix: string; fiscalYear: string; next: number }
  /** Ask a peer for its feed again from a point, after a cursor got ahead of what arrived. */
  | { kind: 'reset_peer_cursor'; deviceId: string; from: number }

/** `numbering.ts`'s kinds of document. */
const DOC_TYPES = new Set(['bill', 'return', 'payment', 'stock_entry', 'stock_count', 'quotation', 'sales_order', 'purchase_order'])

export const REPAIR_KINDS = ['reconcile', 'retry_set_aside', 'free_counter', 'renumber_from', 'reset_peer_cursor'] as const

export interface Pack {
  format: number
  /** Random; a pack is used once, by this id. */
  id: string
  kid: string
  shopId: string
  issuedAt: string
  /** An instant. Past it the pack is refused. */
  expiresAt: string
  /** The support case, said to the owner before they apply it. */
  ticket: string
  repairs: Repair[]
}

export type PackFailure =
  | 'MALFORMED' | 'NOT_CONFIGURED' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' | 'WRONG_SHOP' | 'EXPIRED'

export type PackResult =
  | { ok: true; pack: Pack }
  | { ok: false; code: PackFailure; cause?: string }

export async function verifyPack(
  raw: string,
  keys: readonly SigningKey[],
  expect: { shopId: string | null; now: Date },
): Promise<PackResult> {
  const [encoded, sig, ...extra] = raw.trim().split('.')
  if (!encoded || !sig || extra.length > 0) return { ok: false, code: 'MALFORMED' }

  let pack: Pack | null
  let signature: Uint8Array
  try {
    pack = parsePack(new TextDecoder().decode(fromBase64Url(encoded)))
    signature = fromBase64Url(sig)
  } catch {
    return { ok: false, code: 'MALFORMED' }
  }
  if (pack === null) return { ok: false, code: 'MALFORMED' }

  if (keys.length === 0) return { ok: false, code: 'NOT_CONFIGURED', cause: 'no repair keys in config/repairs.ts' }
  const key = keys.find((k) => k.kid === pack!.kid)
  if (key === undefined) return { ok: false, code: 'UNKNOWN_KEY' }

  let good: boolean
  try {
    good = await verifyEd25519(new TextEncoder().encode(encoded), signature, key.publicKey)
  } catch (e) {
    return { ok: false, code: 'NOT_CONFIGURED', cause: describeCause(e) }
  }
  if (!good) return { ok: false, code: 'BAD_SIGNATURE' }

  // Checked only once the pack is known to be the vendor's: an unsigned one says nothing true.
  if (expect.shopId === null || pack.shopId !== expect.shopId) return { ok: false, code: 'WRONG_SHOP' }
  if (Date.parse(pack.expiresAt) <= expect.now.getTime()) return { ok: false, code: 'EXPIRED' }
  return { ok: true, pack }
}

/** The pack without checking it, for saying why one was refused. */
export function readPackUnverified(raw: string): Pack | null {
  try {
    return parsePack(new TextDecoder().decode(fromBase64Url(raw.trim().split('.')[0] ?? '')))
  } catch {
    return null
  }
}

function parsePack(text: string): Pack | null {
  const v = JSON.parse(text) as Record<string, unknown>
  const str = (k: string) => (typeof v[k] === 'string' && v[k] !== '' ? v[k] as string : null)
  if (v['format'] !== PACK_FORMAT) return null
  const id = str('id'); const kid = str('kid'); const shopId = str('shopId')
  const issuedAt = str('issuedAt'); const expiresAt = str('expiresAt'); const ticket = str('ticket')
  if (!id || !/^[0-9a-f]{16,64}$/.test(id) || !kid || !shopId || !issuedAt || !expiresAt || ticket === null) return null
  if (Number.isNaN(Date.parse(expiresAt))) return null
  if (!Array.isArray(v['repairs']) || v['repairs'].length === 0 || v['repairs'].length > 20) return null
  const repairs = v['repairs'].map(parseRepair)
  if (repairs.some((r) => r === null)) return null
  return { format: PACK_FORMAT, id, kid, shopId, issuedAt, expiresAt, ticket, repairs: repairs as Repair[] }
}

function parseRepair(raw: unknown): Repair | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const s = (k: string) => (typeof r[k] === 'string' && (r[k] as string).length > 0 && (r[k] as string).length <= 64 ? r[k] as string : null)
  const n = (k: string) => (typeof r[k] === 'number' && Number.isInteger(r[k]) && (r[k] as number) >= 0 ? r[k] as number : null)
  switch (r['kind']) {
    case 'reconcile': {
      const what = r['what']
      return what === 'all' || what === 'stock' || what === 'returned' || what === 'fulfilled' || what === 'loyalty' || what === 'reversals'
        ? { kind: 'reconcile', what } : null
    }
    case 'retry_set_aside':
      return { kind: 'retry_set_aside' }
    case 'free_counter': {
      const registerId = s('registerId')
      return registerId ? { kind: 'free_counter', registerId } : null
    }
    case 'renumber_from': {
      const docType = s('docType'); const prefix = s('prefix'); const fiscalYear = s('fiscalYear'); const next = n('next')
      return docType && DOC_TYPES.has(docType) && prefix && fiscalYear && /^\d{4}$/.test(fiscalYear) && next !== null && next >= 1 ? { kind: 'renumber_from', docType, prefix, fiscalYear, next } : null
    }
    case 'reset_peer_cursor': {
      const deviceId = s('deviceId'); const from = n('from')
      return deviceId && from !== null ? { kind: 'reset_peer_cursor', deviceId, from } : null
    }
    default:
      return null
  }
}
