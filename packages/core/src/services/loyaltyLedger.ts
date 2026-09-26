import type { SqlDriver } from '../db/driver.js'
import { applyingRemote } from './changefeed.js'

/**
 * The loyalty caches, held to the records they describe.
 *
 * Four figures are edited in place one step at a time, and so can each lose a
 * step when two tills make one while apart and a merge keeps one copy:
 *
 * - `loyalty_redemptions.restored`: what returns handed back of a redemption.
 *   The truth is `sales_returns.points_restored`, spread over the bill's
 *   redemptions oldest first -- exactly as `restorePoints` spreads it.
 * - `loyalty_entries.points`: what an entry is worth after returns took some
 *   back. The truth is `earned` (053) less the `points_removed` of the bill's
 *   submitted returns.
 * - `loyalty_entries.cancelled_at`: set when the bill is cancelled, or when
 *   returns took back everything it earned.
 * - `loyalty_entries.consumed`: what was spent from the entry, which is the
 *   sum over its redemptions of what they took less what came back.
 *
 * Returns and bills travel whole, as records of their own, so after a merge
 * they are what both tills agree on.
 *
 * ## Each figure is only ever corrected in the direction that is safe
 *
 * A derived figure can be wrong for a reason that looks, from here, exactly
 * like a lost step: a bill or a return that has not arrived yet -- paged into
 * a later batch, or quarantined. So each figure is corrected only the way that
 * cannot hand a customer points the shop did not give:
 *
 * | figure | corrected | because a missing record would make the derived one |
 * |---|---|---|
 * | consumed | upwards | too low (a redemption not here yet) |
 * | restored | downwards | too high is impossible; too low (a return not here yet) is left |
 * | points | downwards | too high (a clawback not here yet) |
 * | cancelled | set, never cleared | not set (a cancel not here yet) |
 *
 * A difference in the other direction is returned as drift and left for a
 * person. Too few points for a while costs a customer; too many costs the shop.
 */

export interface LoyaltyDrift {
  /** The entry or redemption the difference is on. */
  id: string
  customerId: string
  figure: 'consumed' | 'restored' | 'points' | 'cancelled'
  stored: number
  derived: number
  /** False for a difference this pass deliberately does not act on. */
  repairable: boolean
}

interface EntryRow {
  id: string
  customer_id: string
  bill_id: string | null
  points: number
  earned: number | null
  consumed: number
  cancelled_at: string | null
  bill_cancelled: number
  removed: number
}

interface RedemptionRow {
  id: string
  customer_id: string
  bill_id: string
  loyalty_entry_id: string
  points: number
  restored: number
  created_at: string
}

/** Enough placeholders per statement to stay well under SQLite's limit. */
const CHUNK = 400

/**
 * Every figure that disagrees with its records, and, with `repair`, the
 * repairable ones put right -- written as a merge is, change feed and revision
 * triggers standing down, because every till derives the same answer from the
 * same rows. `customerIds` scopes it to the customers a batch touched; null or
 * absent means every customer.
 */
export async function reconcileLoyalty(
  db: SqlDriver, opts: { repair?: boolean; customerIds?: readonly string[] | null } = {},
): Promise<LoyaltyDrift[]> {
  const scope = opts.customerIds ?? null
  if (scope !== null && scope.length === 0) return []

  const drift: LoyaltyDrift[] = []
  for (let i = 0; i < (scope?.length ?? 1); i += CHUNK) {
    const ids = scope === null ? null : scope.slice(i, i + CHUNK)
    drift.push(...await driftAmong(db, ids))
  }

  const fix = drift.filter((d) => d.repairable)
  if (opts.repair && fix.length > 0) {
    await applyingRemote(db, async (tx) => {
      for (const d of fix) await apply(tx, d)
    })
  }
  return drift
}

async function driftAmong(db: SqlDriver, customers: readonly string[] | null): Promise<LoyaltyDrift[]> {
  const inList = customers === null ? '' : `IN (${customers.map(() => '?').join(', ')})`
  const args: string[] = customers === null ? [] : [...customers]

  // raw: correlated sums per entry, which the builder cannot say.
  const entries = await db.query<EntryRow>(
    `SELECT le.id, le.customer_id, le.bill_id, le.points, le.earned, le.consumed, le.cancelled_at,
            COALESCE((SELECT b.docstatus = 2 FROM bills b WHERE b.id = le.bill_id), 0) AS bill_cancelled,
            COALESCE((SELECT SUM(r.points_removed) FROM sales_returns r
                       WHERE r.bill_id = le.bill_id AND r.docstatus = 1), 0) AS removed
       FROM loyalty_entries le
      ${customers === null ? '' : `WHERE le.customer_id ${inList}`}`,
    args,
  )
  const redemptions = await db.query<RedemptionRow>(
    `SELECT id, customer_id, bill_id, loyalty_entry_id, points, restored, created_at
       FROM loyalty_redemptions
      WHERE reversed_at IS NULL ${customers === null ? '' : `AND customer_id ${inList}`}
      ORDER BY bill_id, created_at, id`,
    args,
  )
  // raw: a per-bill sum over one table, keyed for the spread below.
  const restoredByBill = new Map((await db.query<{ bill_id: string; restored: number }>(
    `SELECT bill_id, SUM(points_restored) AS restored FROM sales_returns
      WHERE docstatus = 1 AND bill_id IN (SELECT DISTINCT bill_id FROM loyalty_redemptions
                                           WHERE reversed_at IS NULL ${customers === null ? '' : `AND customer_id ${inList}`})
      GROUP BY bill_id`,
    args,
  )).map((r) => [r.bill_id, r.restored]))

  const drift: LoyaltyDrift[] = []

  /* Restored, spread over each bill's redemptions oldest first, as
     `restorePoints` hands it back. The effective figure for `consumed` below
     is the lower of stored and derived: a restore not here yet must not make
     the entry look less spent than it may be. */
  const effectiveRestored = new Map<string, number>()
  let bill: string | null = null
  let left = 0
  for (const r of redemptions) {
    if (r.bill_id !== bill) { bill = r.bill_id; left = restoredByBill.get(r.bill_id) ?? 0 }
    const derived = Math.min(r.points, Math.max(0, left))
    left -= derived
    effectiveRestored.set(r.id, Math.min(r.restored, derived))
    if (derived !== r.restored) {
      drift.push({
        id: r.id, customerId: r.customer_id, figure: 'restored',
        stored: r.restored, derived, repairable: derived < r.restored,
      })
    }
  }

  const spentFrom = new Map<string, number>()
  for (const r of redemptions) {
    spentFrom.set(r.loyalty_entry_id,
      (spentFrom.get(r.loyalty_entry_id) ?? 0) + r.points - (effectiveRestored.get(r.id) ?? r.restored))
  }

  for (const e of entries) {
    const cancelled = e.bill_cancelled === 1 || (e.earned !== null && e.removed >= e.earned)
    if (cancelled && e.cancelled_at === null) {
      drift.push({ id: e.id, customerId: e.customer_id, figure: 'cancelled', stored: 0, derived: 1, repairable: true })
    }
    if (!cancelled && e.cancelled_at !== null && e.bill_cancelled === 0) {
      drift.push({ id: e.id, customerId: e.customer_id, figure: 'cancelled', stored: 1, derived: 0, repairable: false })
    }

    /* Points only while the entry stands: a cancelled one counts for nothing,
       and a clawback that cancelled it left `points` where it was. */
    const points = e.earned !== null && !cancelled ? e.earned - e.removed : e.points
    if (points !== e.points) {
      drift.push({
        id: e.id, customerId: e.customer_id, figure: 'points',
        stored: e.points, derived: points, repairable: points < e.points && points > 0,
      })
    }

    const consumed = Math.min(Math.min(points, e.points), Math.max(0, spentFrom.get(e.id) ?? 0))
    if (consumed !== e.consumed) {
      drift.push({
        id: e.id, customerId: e.customer_id, figure: 'consumed',
        stored: e.consumed, derived: consumed, repairable: consumed > e.consumed,
      })
    }
  }
  return drift
}

async function apply(tx: SqlDriver, d: LoyaltyDrift): Promise<void> {
  switch (d.figure) {
    case 'restored':
      // raw: one figure, worked out above.
      await tx.execute('UPDATE loyalty_redemptions SET restored = ? WHERE id = ? AND restored > ?',
        [d.derived, d.id, d.derived])
      return
    case 'points':
      await tx.execute('UPDATE loyalty_entries SET points = ?, consumed = MIN(consumed, ?) WHERE id = ? AND points > ?',
        [d.derived, d.derived, d.id, d.derived])
      return
    case 'consumed':
      await tx.execute('UPDATE loyalty_entries SET consumed = MIN(points, MAX(consumed, ?)) WHERE id = ?',
        [d.derived, d.id])
      return
    case 'cancelled':
      await tx.execute(
        `UPDATE loyalty_entries
            SET cancelled_at = COALESCE((SELECT b.cancelled_at FROM bills b
                                          WHERE b.id = loyalty_entries.bill_id AND b.docstatus = 2),
                                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          WHERE id = ? AND cancelled_at IS NULL`,
        [d.id],
      )
  }
}
