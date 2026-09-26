import { eq, and, gt, isNull, desc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, ZERO, paise } from '../../money.js'
import type { RefundBasis } from '../../domain/returns.js'
import { SUBMITTED } from '../../integrity/docstatus.js'
import { ALLOCATED_TO_BILL } from '../payments/outstanding.js'

/*
 * The money and the points a return moves: how a refund divides between the
 * drawer and the customer's account, and the loyalty that goes back with it.
 */

/**
 * What this bill has paid back already, and in what.
 *
 * Cumulative rather than per-return, because that is what makes the last return
 * hand back the exact remainder instead of a rounded share of it.
 */
export async function refundBasis(db: SqlDriver, billId: string): Promise<RefundBasis> {
  const [bill] = await q(db)
    .select({ grandTotal: schema.bills.grandTotal })
    .from(schema.bills)
    .where(eq(schema.bills.id, billId))

  /* COALESCE on every sum, because a SUM over no rows is null and every one of
     these figures is arithmetic the moment it comes back. */
  const [paidWithPoints] = await q(db)
    .select({ amount: sql<Money>`COALESCE(SUM(${schema.billPayments.amount}), 0)` })
    .from(schema.billPayments)
    .where(and(
      eq(schema.billPayments.billId, billId),
      eq(schema.billPayments.method, 'loyalty'),
    ))

  const [redeemed] = await q(db)
    .select({ points: sql<number>`COALESCE(SUM(${schema.loyaltyRedemptions.points}), 0)` })
    .from(schema.loyaltyRedemptions)
    .where(and(
      eq(schema.loyaltyRedemptions.billId, billId),
      isNull(schema.loyaltyRedemptions.reversedAt),
    ))

  const [earned] = await q(db)
    .select({ points: schema.loyaltyEntries.points, consumed: schema.loyaltyEntries.consumed })
    .from(schema.loyaltyEntries)
    .where(and(
      eq(schema.loyaltyEntries.billId, billId),
      isNull(schema.loyaltyEntries.cancelledAt),
    ))

  const [priorReturns] = await q(db)
    .select({
      refunded: sql<Money>`COALESCE(SUM(${schema.salesReturns.refundTotal}), 0)`,
      asPoints: sql<Money>`COALESCE(SUM(${schema.salesReturns.refundTotal} - ${schema.salesReturns.refundCash}), 0)`,
      removed: sql<number>`COALESCE(SUM(${schema.salesReturns.pointsRemoved}), 0)`,
    })
    .from(schema.salesReturns)
    .where(and(
      eq(schema.salesReturns.billId, billId),
      eq(schema.salesReturns.docstatus, SUBMITTED),
    ))

  return {
    billTotal: bill?.grandTotal ?? ZERO,
    pointsValue: paidWithPoints?.amount ?? ZERO,
    pointsRedeemed: redeemed?.points ?? 0,
    pointsEarned: earned?.points ?? 0,
    pointsEarnedSpent: earned?.consumed ?? 0,
    alreadyRefunded: priorReturns?.refunded ?? ZERO,
    alreadyRestoredValue: priorReturns?.asPoints ?? ZERO,
    alreadyRemovedPoints: priorReturns?.removed ?? 0,
  }
}

/**
 * Points spent on the bill go back to the entries they came out of, so they keep
 * the expiry they were earned with. An entry that has expired in the meantime
 * gives back nothing usable — resurrecting expired points would be a gift the
 * shop never offered.
 */
export async function restorePoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
  const rows = await q(tx)
    .select({
      id: schema.loyaltyRedemptions.id,
      loyaltyEntryId: schema.loyaltyRedemptions.loyaltyEntryId,
      points: schema.loyaltyRedemptions.points,
      restored: schema.loyaltyRedemptions.restored,
    })
    .from(schema.loyaltyRedemptions)
    .where(and(
      eq(schema.loyaltyRedemptions.billId, billId),
      isNull(schema.loyaltyRedemptions.reversedAt),
    ))
    .orderBy(schema.loyaltyRedemptions.createdAt)

  let remaining = points
  for (const row of rows) {
    if (remaining <= 0) break
    const take = Math.min(remaining, row.points - row.restored)
    if (take <= 0) continue
    await q(tx).update(schema.loyaltyEntries)
      .set({ consumed: sql`${schema.loyaltyEntries.consumed} - ${take}` })
      .where(eq(schema.loyaltyEntries.id, row.loyaltyEntryId))
    await q(tx).update(schema.loyaltyRedemptions)
      .set({ restored: sql`${schema.loyaltyRedemptions.restored} + ${take}` })
      .where(eq(schema.loyaltyRedemptions.id, row.id))
    remaining -= take
  }
}

/** The same, backwards, when the return itself is cancelled. */
export async function unrestorePoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
  const rows = await q(tx)
    .select({
      id: schema.loyaltyRedemptions.id,
      loyaltyEntryId: schema.loyaltyRedemptions.loyaltyEntryId,
      restored: schema.loyaltyRedemptions.restored,
    })
    .from(schema.loyaltyRedemptions)
    .where(and(
      eq(schema.loyaltyRedemptions.billId, billId),
      isNull(schema.loyaltyRedemptions.reversedAt),
      gt(schema.loyaltyRedemptions.restored, 0),
    ))
    .orderBy(desc(schema.loyaltyRedemptions.createdAt))

  let remaining = points
  for (const row of rows) {
    if (remaining <= 0) break
    const take = Math.min(remaining, row.restored)
    await q(tx).update(schema.loyaltyEntries)
      .set({ consumed: sql`${schema.loyaltyEntries.consumed} + ${take}` })
      .where(eq(schema.loyaltyEntries.id, row.loyaltyEntryId))
    await q(tx).update(schema.loyaltyRedemptions)
      .set({ restored: sql`${schema.loyaltyRedemptions.restored} - ${take}` })
      .where(eq(schema.loyaltyRedemptions.id, row.id))
    remaining -= take
  }
}

/**
 * Points the bill earned come off the entry that granted them.
 *
 * Taking the last one off cancels the entry rather than setting it to zero: the
 * column will not hold a zero, and cancelling is what the bill's own cancellation
 * does, so both paths leave the same shape behind.
 */
export async function clawBackPoints(tx: SqlDriver, billId: string, points: number, nowIso: string): Promise<void> {
  const [entry] = await q(tx)
    .select({ id: schema.loyaltyEntries.id, points: schema.loyaltyEntries.points })
    .from(schema.loyaltyEntries)
    .where(and(
      eq(schema.loyaltyEntries.billId, billId),
      isNull(schema.loyaltyEntries.cancelledAt),
    ))
  if (!entry) return

  if (points >= entry.points) {
    await q(tx).update(schema.loyaltyEntries)
      .set({ cancelledAt: nowIso })
      .where(eq(schema.loyaltyEntries.id, entry.id))
    return
  }
  await q(tx).update(schema.loyaltyEntries)
    .set({ points: sql`${schema.loyaltyEntries.points} - ${points}` })
    .where(eq(schema.loyaltyEntries.id, entry.id))
}

export async function regrantPoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
  const [entry] = await q(tx)
    .select({
      id: schema.loyaltyEntries.id,
      points: schema.loyaltyEntries.points,
      cancelledAt: schema.loyaltyEntries.cancelledAt,
    })
    .from(schema.loyaltyEntries)
    .where(eq(schema.loyaltyEntries.billId, billId))
  if (!entry) return

  if (entry.cancelledAt !== null && entry.points === points) {
    await q(tx).update(schema.loyaltyEntries)
      .set({ cancelledAt: null })
      .where(eq(schema.loyaltyEntries.id, entry.id))
    return
  }
  await q(tx).update(schema.loyaltyEntries)
    .set({ points: sql`${schema.loyaltyEntries.points} + ${points}` })
    .where(eq(schema.loyaltyEntries.id, entry.id))
}

export async function refundedSoFar(db: SqlDriver, billItemId: string): Promise<Money> {
  const [row] = await q(db)
    .select({ total: sql<Money>`COALESCE(SUM(${schema.salesReturnItems.refundAmount}), 0)` })
    .from(schema.salesReturnItems)
    .innerJoin(schema.salesReturns, and(
      eq(schema.salesReturns.id, schema.salesReturnItems.returnId),
      eq(schema.salesReturns.docstatus, SUBMITTED),
    ))
    .where(eq(schema.salesReturnItems.billItemId, billItemId))
  return row?.total ?? ZERO
}

/* One definition of "allocated", shared with billing and payments. */
const ALLOCATED = ALLOCATED_TO_BILL

/** What is still owed on one bill. */
export async function outstandingOn(db: SqlDriver, billId: string): Promise<Money> {
  const [row] = await q(db)
    .select({ due: sql<number>`${schema.bills.creditTotal} - ${ALLOCATED}` })
    .from(schema.bills)
    .where(eq(schema.bills.id, billId))
  return paise(Math.max(0, row?.due ?? 0))
}

/** What is still owed across every bill of one customer. */
export async function outstandingFor(db: SqlDriver, customerId: string): Promise<Money> {
  const [row] = await q(db)
    .select({ due: sql<number>`COALESCE(SUM(${schema.bills.creditTotal} - ${ALLOCATED}), 0)` })
    .from(schema.bills)
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
      gt(schema.bills.creditTotal, ZERO),
    ))
  return paise(Math.max(0, row?.due ?? 0))
}

export const ZERO_REFUND = ZERO
