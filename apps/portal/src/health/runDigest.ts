import type { SqlDriver } from '@shopos/core'
import { alertsFor } from './alerts.js'
import { latestPerTill, logSupport } from './store.js'
import { digestDue, digestText, istDay, sendToTelegram, type DigestBot } from './digest.js'

/*
 * Sends the morning digest once a day, and says when it last went in the
 * support log -- so the portal restarting at nine does not send it twice, and
 * "did yesterday's go" has an answer.
 */

const SYSTEM = 'system'
/** How often a running portal asks whether the digest is due. */
export const DIGEST_CHECK_MS = 10 * 60_000

export type DigestOutcome =
  | { sent: true; text: string }
  | { sent: false; why: 'not_due' | 'no_bot' }
  | { sent: false; why: 'failed'; error: string }

export async function runDigest(
  db: SqlDriver,
  bot: DigestBot | null,
  opts: { now?: Date; force?: boolean; fetcher?: typeof fetch } = {},
): Promise<DigestOutcome> {
  const now = opts.now ?? new Date()
  if (bot === null) return { sent: false, why: 'no_bot' }

  const last = await db.get<{ detail: string | null }>(
    `SELECT detail FROM support_log WHERE action = 'digest' ORDER BY at DESC LIMIT 1`,
  )
  if (opts.force !== true && !digestDue(now, last?.detail ?? null)) return { sent: false, why: 'not_due' }

  const tills = await latestPerTill(db)
  const names = new Map<string, string | null>()
  for (const t of tills) if (!names.get(t.shopId)) names.set(t.shopId, t.shopName)
  const text = digestText(alertsFor(tills, now), { shops: names.size, tills: tills.length, names })

  const sent = await sendToTelegram(bot, text, opts.fetcher)
  if (!sent.ok) return { sent: false, why: 'failed', error: sent.error }
  await logSupport(db, { accountId: SYSTEM, action: 'digest', shopId: null, detail: istDay(now), now })
  return { sent: true, text }
}
