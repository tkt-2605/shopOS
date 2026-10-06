import type { SqlDriver } from '../../db/driver.js'
import { applyingRemote } from '../changefeed.js'

/**
 * `bill_items.returned_qty`, held to the returns that describe it.
 *
 * It is a cache: a bill line has had back exactly what its submitted returns
 * say, which is what `submitReturn` adds and `cancelReturn` takes off, one
 * step at a time. The steps do not survive a merge. Two tills that each take
 * a partial return of one bill while apart both raise the bill's revision, one
 * copy of the bill wins, and the other till's increment is gone -- while both
 * returns, which are their own records, arrive intact. Read back as "how much
 * can still be returned", the lost increment is an over-return waiting.
 *
 * Raised freely, lowered only on proof. A derived figure below the stored one
 * is either a lost decrement from a return cancelled on the other till, or a
 * return that has not arrived yet -- paged into a later batch, or quarantined.
 * Lowering on the second would let the same goods be refunded twice; leaving
 * it high only refuses a return until the rows arrive. So a downward
 * difference is returned as drift and not acted on -- except by the quantity
 * of a return whose cancellation has just arrived (`cancelledNow`), which is
 * the proof. Without that, a bill whose corrected copy arrived a batch ahead
 * of the cancellation was raised by this pass for a return that had already
 * been undone, and stayed raised: that till refused a return the rest of the
 * shop would take (`syncInAnyOrder.test.ts`).
 *
 * Clamped to the line's quantity, because the CHECK would otherwise refuse the
 * honest sum and the whole merge with it.
 */

export interface ReturnedQtyDrift {
  billItemId: string
  stored: number
  derived: number
  /** False for a difference this pass deliberately does not act on. */
  repairable: boolean
}

/* raw: a correlated subquery per bill line, which the builder cannot say. */
const DERIVED = `
  SELECT bi.id AS bill_item_id, bi.bill_id, bi.returned_qty AS stored,
         MIN(bi.qty, COALESCE((
           SELECT SUM(ri.qty) FROM sales_return_items ri
             JOIN sales_returns r ON r.id = ri.return_id
            WHERE ri.bill_item_id = bi.id AND r.docstatus = 1), 0)) AS derived
    FROM bill_items bi`

/** Enough placeholders per statement to stay well under SQLite's limit. */
const CHUNK = 400

/**
 * Every bill line whose returned quantity disagrees with its returns, and,
 * with `repair`, each one put right -- written as a merge is, because every
 * till derives the same figure from the same rows. `billIds` scopes it to the
 * bills a batch touched; null or absent means every line.
 */
export async function reconcileReturnedQty(
  db: SqlDriver,
  opts: {
    repair?: boolean
    billIds?: readonly string[] | null
    /**
     * Returns whose cancellation the merge just brought in -- cancelled now
     * and not before it. A line may come down by their quantities, never
     * below what its submitted returns add up to.
     */
    cancelledNow?: readonly string[]
  } = {},
): Promise<ReturnedQtyDrift[]> {
  const scope = opts.billIds ?? null
  if (scope !== null && scope.length === 0) return []

  const drift: (ReturnedQtyDrift & { to: number })[] = []
  for (let i = 0; i < (scope?.length ?? 1); i += CHUNK) {
    const ids = scope === null ? null : scope.slice(i, i + CHUNK)
    const where = ids === null ? '' : ` WHERE bi.bill_id IN (${ids.map(() => '?').join(', ')})`
    const rows = await db.query<{ bill_item_id: string; stored: number; derived: number }>(
      `SELECT * FROM (${DERIVED}${where}) WHERE stored <> derived`, ids ?? [],
    )
    for (const r of rows) {
      const undone = r.derived < r.stored ? await undoneOn(db, r.bill_item_id, opts.cancelledNow ?? []) : 0
      const to = r.derived > r.stored ? r.derived : Math.max(r.derived, r.stored - undone)
      drift.push({ billItemId: r.bill_item_id, stored: r.stored, derived: r.derived, repairable: to === r.derived, to })
    }
  }

  const fix = drift.filter((d) => d.to !== d.stored)
  if (opts.repair && fix.length > 0) {
    await applyingRemote(db, async (tx) => {
      for (const d of fix) {
        // raw: the figure comes from the correlated query above.
        await tx.execute('UPDATE bill_items SET returned_qty = ? WHERE id = ?', [d.to, d.billItemId])
      }
    })
  }

  return drift.map(({ to: _to, ...d }) => d)
}

/** How much of one bill line the returns cancelled just now had taken back. */
async function undoneOn(db: SqlDriver, billItemId: string, cancelled: readonly string[]): Promise<number> {
  if (cancelled.length === 0) return 0
  let total = 0
  for (let i = 0; i < cancelled.length; i += CHUNK) {
    const ids = cancelled.slice(i, i + CHUNK)
    // raw: an IN list as long as the merge's cancellations.
    const row = await db.get<{ q: number | null }>(
      `SELECT SUM(ri.qty) AS q FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id
        WHERE ri.bill_item_id = ? AND r.docstatus = 2 AND r.id IN (${ids.map(() => '?').join(', ')})`,
      [billItemId, ...ids])
    total += row?.q ?? 0
  }
  return total
}
