import { randomBytes, type webcrypto } from 'node:crypto'
import type { SqlDriver } from '@shopos/core'
import { isTier, type LicenceToken, type Tier } from '@shopos/core/licence'
import { signToken } from './keys.js'
import type { IssuedLicence } from './store.js'

/**
 * Minting licences, and remembering what was minted.
 *
 * Every issue is a new row, never an update. "What did we send them in March"
 * is the question a billing dispute actually asks, and a table holding only
 * the current licence cannot answer it. It also means a shop that has lost
 * its code is served from history rather than re-signed, so the same shop and
 * the same period always produce the same bytes.
 */

export interface IssueInput {
  shopId: string
  tier: Tier
  /** Business date, or null for perpetual. */
  paidThrough: string | null
  tills: number
  kid: string
  /** Who issued it — a CLI user, or an account id from the portal. */
  issuedBy?: string | null
  now?: Date
}

export type IssueResult =
  | { ok: true; licence: IssuedLicence }
  | { ok: false; code: 'BAD_TIER' | 'BAD_DATE' | 'BAD_TILLS' | 'BAD_SHOP'; detail: string }

export async function issueLicence(
  db: SqlDriver, key: webcrypto.CryptoKey, input: IssueInput,
): Promise<IssueResult> {
  if (input.shopId.trim() === '') {
    return { ok: false, code: 'BAD_SHOP', detail: 'a shop id is required' }
  }
  if (!isTier(input.tier)) {
    return { ok: false, code: 'BAD_TIER', detail: `not a tier: ${String(input.tier)}` }
  }
  if (input.paidThrough !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.paidThrough)) {
    return { ok: false, code: 'BAD_DATE', detail: 'paid-through is YYYY-MM-DD, or omitted for perpetual' }
  }
  if (!Number.isInteger(input.tills) || input.tills < 1) {
    return { ok: false, code: 'BAD_TILLS', detail: 'tills is a whole number, at least 1' }
  }

  const now = input.now ?? new Date()
  const token: LicenceToken = {
    shopId: input.shopId.trim(),
    tier: input.tier,
    paidThrough: input.paidThrough,
    tills: input.tills,
    issuedAt: now.toISOString(),
    kid: input.kid,
  }

  const raw = await signToken(key, token)
  const licence: IssuedLicence = {
    id: randomBytes(16).toString('hex'),
    shopId: token.shopId,
    token: raw,
    tier: token.tier,
    paidThrough: token.paidThrough,
    tills: token.tills,
    kid: token.kid,
    issuedAt: token.issuedAt,
    issuedBy: input.issuedBy ?? null,
  }

  await db.execute(
    `INSERT INTO licences (id, shop_id, token, tier, paid_through, tills, kid, issued_at, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      licence.id, licence.shopId, licence.token, licence.tier, licence.paidThrough,
      licence.tills, licence.kid, licence.issuedAt, licence.issuedBy,
    ],
  )

  return { ok: true, licence }
}

/**
 * The licence a till should be using: the most recent one issued to the shop.
 *
 * "Most recent" is by `issued_at` and then by `id`, so two licences signed in
 * the same millisecond -- which a test does and a fast script can -- still
 * order deterministically rather than by whatever the query planner felt
 * like.
 */
export async function currentLicence(
  db: SqlDriver, shopId: string,
): Promise<IssuedLicence | null> {
  const row = await db.get<{
    id: string; shop_id: string; token: string; tier: string
    paid_through: string | null; tills: number; kid: string
    issued_at: string; issued_by: string | null
  }>(
    `SELECT id, shop_id, token, tier, paid_through, tills, kid, issued_at, issued_by
       FROM licences WHERE shop_id = ?
      ORDER BY issued_at DESC, id DESC LIMIT 1`,
    [shopId],
  )
  if (row === undefined) return null
  return {
    id: row.id, shopId: row.shop_id, token: row.token, tier: row.tier,
    paidThrough: row.paid_through, tills: row.tills, kid: row.kid,
    issuedAt: row.issued_at, issuedBy: row.issued_by,
  }
}

/**
 * Notes that a till asked.
 *
 * The only way the vendor learns how many counters a shop is running, and it
 * is a count for a conversation, never a gate -- `overTillLimit` in core says
 * the same thing from the other side. A shop that adds a counter on a
 * Saturday has not done anything wrong.
 */
export async function noteDevice(
  db: SqlDriver,
  input: { shopId: string; deviceId: string; version?: string | null; now?: Date },
): Promise<void> {
  const seen = (input.now ?? new Date()).toISOString()
  await db.execute(
    `INSERT INTO devices (shop_id, device_id, first_seen, last_seen, version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (shop_id, device_id)
     DO UPDATE SET last_seen = excluded.last_seen, version = excluded.version`,
    [input.shopId, input.deviceId, seen, seen, input.version ?? null],
  )
}

export async function tillsSeen(
  db: SqlDriver, shopId: string, since: Date,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM devices WHERE shop_id = ? AND last_seen > ?',
    [shopId, since.toISOString()],
  )
  return row?.n ?? 0
}
