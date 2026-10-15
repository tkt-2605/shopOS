import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SqlDriver } from '@shopos/core'
import type { Report, TillSummary } from './read.js'
import type { TillLatest } from './alerts.js'

/*
 * Health reports as the portal keeps them, and the key each till proves
 * itself with.
 *
 * ## The key
 *
 * Every shop sends, on every plan, so there is no licence to sign a report
 * with -- a free shop has none. Instead the first report from a till is
 * accepted and answered with a key, which the till keeps and sends with every
 * report after. A report for that till without the key, or with another, is
 * refused. That is trust on first use: it cannot stop somebody who knows a
 * shop's id writing that shop's first report, and it does stop them writing
 * any after the shop's own till has. Support can forget a key from the
 * console when a till is rebuilt from nothing.
 */

/** Reports kept per till. A month of dailies, and the restarts that send more. */
export const KEEP_PER_TILL = 60

export type Received =
  | { ok: true; id: string; key: string | null }
  | { ok: false; code: 'BAD_KEY' }

export async function receiveReport(
  db: SqlDriver,
  input: { report: Report; body: string; key: string | null; now: Date },
): Promise<Received> {
  const { report, now } = input
  const held = await db.get<{ key_hash: string }>(
    'SELECT key_hash FROM health_keys WHERE shop_id = ? AND device_id = ?', [report.shopId, report.deviceId],
  )

  let issued: string | null = null
  if (held === undefined) {
    issued = randomBytes(32).toString('base64url')
    await db.execute(
      'INSERT INTO health_keys (shop_id, device_id, key_hash, created_at) VALUES (?, ?, ?, ?)',
      [report.shopId, report.deviceId, hash(issued), now.toISOString()],
    )
  } else if (input.key === null || !same(hash(input.key), held.key_hash)) {
    return { ok: false, code: 'BAD_KEY' }
  }

  const id = randomBytes(16).toString('hex')
  await db.execute(
    `INSERT INTO health_reports (id, shop_id, device_id, shop_name, received_at, generated_at, version, summary, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, report.shopId, report.deviceId, report.shopName, now.toISOString(), report.generatedAt,
      report.version, JSON.stringify(report.summary), input.body],
  )
  await db.execute(
    `DELETE FROM health_reports WHERE shop_id = ? AND device_id = ? AND id NOT IN (
       SELECT id FROM health_reports WHERE shop_id = ? AND device_id = ?
        ORDER BY received_at DESC LIMIT ?)`, // raw: a correlated keep-the-newest
    [report.shopId, report.deviceId, report.shopId, report.deviceId, KEEP_PER_TILL],
  )
  return { ok: true, id, key: issued }
}

export interface TillRow extends TillLatest {
  reportId: string
  shopName: string | null
}

/** Every till's newest report, optionally for one shop. */
export async function latestPerTill(db: SqlDriver, shopId?: string): Promise<TillRow[]> {
  const rows = await db.query<{
    id: string; shop_id: string; device_id: string; shop_name: string | null; received_at: string; summary: string
  }>(
    `SELECT id, shop_id, device_id, shop_name, received_at, summary FROM (
       SELECT r.*, ROW_NUMBER() OVER (
                PARTITION BY r.shop_id, r.device_id ORDER BY r.received_at DESC, r.rowid DESC) AS n
         FROM health_reports r
        WHERE (? IS NULL OR r.shop_id = ?))
      WHERE n = 1
      ORDER BY shop_id, device_id`, // raw: newest per till by window function; two reports in one millisecond are still one till
    [shopId ?? null, shopId ?? null],
  )
  return rows.map((r) => ({
    reportId: r.id,
    shopId: r.shop_id,
    deviceId: r.device_id,
    shopName: r.shop_name,
    receivedAt: r.received_at,
    summary: JSON.parse(r.summary) as TillSummary,
  }))
}

/** One till's reports, newest first, as summaries. */
export async function historyOf(
  db: SqlDriver, shopId: string, deviceId: string, limit = 30,
): Promise<{ id: string; receivedAt: string; summary: TillSummary }[]> {
  const rows = await db.query<{ id: string; received_at: string; summary: string }>(
    `SELECT id, received_at, summary FROM health_reports
      WHERE shop_id = ? AND device_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?`,
    [shopId, deviceId, limit],
  )
  return rows.map((r) => ({ id: r.id, receivedAt: r.received_at, summary: JSON.parse(r.summary) as TillSummary }))
}

export async function reportBody(db: SqlDriver, id: string): Promise<{ shopId: string; body: string } | null> {
  const row = await db.get<{ shop_id: string; body: string }>('SELECT shop_id, body FROM health_reports WHERE id = ?', [id])
  return row === undefined ? null : { shopId: row.shop_id, body: row.body }
}

/** For a till rebuilt from nothing that still has its old device id: its next report sets a new key. */
export async function forgetKey(db: SqlDriver, shopId: string, deviceId: string): Promise<void> {
  await db.execute('DELETE FROM health_keys WHERE shop_id = ? AND device_id = ?', [shopId, deviceId])
}

export async function logSupport(
  db: SqlDriver,
  input: { accountId: string; action: string; shopId: string | null; detail?: string | null; now: Date },
): Promise<void> {
  await db.execute(
    'INSERT INTO support_log (id, at, account_id, action, shop_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [randomBytes(16).toString('hex'), input.now.toISOString(), input.accountId, input.action, input.shopId, input.detail ?? null],
  )
}

function hash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
