import { eq, and, isNull, notInArray, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import {
  SUBMITTED, CANCELLED, assertCanApply, assertAmendable, parseDocStatus,
} from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { recheckDocStatus } from '../../integrity/transition.js'
import { reverseVoucher } from '../stock.js'
import { reverseBatches } from '../batches.js'
import { openSessionFor, postCashMovement } from '../cash.js'
import { reverseBillFulfilment } from '../documents.js'
import { createBill } from './draft.js'
import { loadBill } from './load.js'
import type { CancelBillResult, CreateBillResult } from './types.js'

/*
 * Undoing a submitted bill, and replacing one with a corrected copy.
 */

export async function cancelBill(
  db: SqlDriver,
  input: { billId: string; reason?: string; actorId: string; now?: Date },
): Promise<CancelBillResult> {
  const now = input.now ?? new Date()
  const bill = await loadBill(db, input.billId)
  assertCanApply('bill', parseDocStatus(bill.docstatus), 'cancel')

  const [returns] = await q(db)
    .select({ n: sql<number>`count(*)` })
    .from(schema.salesReturns)
    .where(and(
      eq(schema.salesReturns.billId, input.billId),
      eq(schema.salesReturns.docstatus, SUBMITTED),
    ))
  if ((returns?.n ?? 0) > 0) return { ok: false, code: 'HAS_RETURNS', returnCount: returns!.n }

  const [allocations] = await q(db)
    .select({ n: sql<number>`count(*)` })
    .from(schema.paymentAllocations)
    .innerJoin(schema.paymentEntries, and(
      eq(schema.paymentEntries.id, schema.paymentAllocations.paymentId),
      eq(schema.paymentEntries.docstatus, SUBMITTED),
    ))
    .where(eq(schema.paymentAllocations.billId, input.billId))
  if ((allocations?.n ?? 0) > 0) return { ok: false, code: 'HAS_PAYMENTS', paymentCount: allocations!.n }

  const nowIso = now.toISOString()

  /* Everything except credit and points. Neither was posted to the session on
     the way in -- credit moved no money and points are not a tender the drawer
     holds -- so there is nothing to hand back out for them. */
  const tenders = await q(db)
    .select({ method: schema.billPayments.method, amount: schema.billPayments.amount })
    .from(schema.billPayments)
    .where(and(
      eq(schema.billPayments.billId, input.billId),
      notInArray(schema.billPayments.method, ['credit', 'loyalty']),
    ))

  await db.transaction(async (tx) => {
    await recheckDocStatus(tx, 'bills', input.billId, 'bill', 'cancel')
    await reverseVoucher(tx, 'bill', input.billId, bill.postingDate, input.actorId)
    await reverseBatches(tx, 'bill', input.billId, bill.postingDate, input.actorId)

    const session = await openSessionFor(tx, bill.registerId)
    if (session) {
      for (const tender of tenders) {
        await postCashMovement(tx, {
          sessionId: session,
          direction: 'out',
          amount: tender.amount,
          method: tender.method as 'cash' | 'upi' | 'card',
          sourceType: 'bill_cancel',
          sourceId: input.billId,
          userId: input.actorId,
          now,
        })
      }
    }

    // Only the part still outstanding. A return against this bill may already
    // have handed some of these points back, and taking them off `consumed` a
    // second time would invent points the customer never had.
    const redemptions = await q(tx)
      .select({
        id: schema.loyaltyRedemptions.id,
        loyaltyEntryId: schema.loyaltyRedemptions.loyaltyEntryId,
        owed: sql<number>`${schema.loyaltyRedemptions.points} - ${schema.loyaltyRedemptions.restored}`,
      })
      .from(schema.loyaltyRedemptions)
      .where(and(
        eq(schema.loyaltyRedemptions.billId, input.billId),
        isNull(schema.loyaltyRedemptions.reversedAt),
      ))

    for (const r of redemptions) {
      if (r.owed > 0) {
        await q(tx).update(schema.loyaltyEntries)
          .set({ consumed: sql`${schema.loyaltyEntries.consumed} - ${r.owed}` })
          .where(eq(schema.loyaltyEntries.id, r.loyaltyEntryId))
      }
      await q(tx).update(schema.loyaltyRedemptions)
        .set({ reversedAt: nowIso })
        .where(eq(schema.loyaltyRedemptions.id, r.id))
    }

    await q(tx).update(schema.loyaltyEntries)
      .set({ cancelledAt: nowIso })
      .where(and(
        eq(schema.loyaltyEntries.billId, input.billId),
        isNull(schema.loyaltyEntries.cancelledAt),
      ))

    /* What this bill took off an order goes back. Otherwise a cancelled bill
       leaves an order claiming it was delivered, and the goods are never sent. */
    await reverseBillFulfilment(tx, { billId: input.billId, actorId: input.actorId })

    await q(tx).update(schema.bills)
      .set({
        docstatus: CANCELLED,
        cancelledBy: input.actorId,
        cancelledAt: nowIso,
        cancelReason: input.reason ?? null,
        updatedAt: nowIso,
      })
      .where(eq(schema.bills.id, input.billId))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: input.billId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, billId: input.billId }
}

/**
 * Amend copies a cancelled bill into a fresh draft. It does not resurrect the
 * original — the cancelled document stays on the record with the new one linked
 * to it, which is what makes "edit a bill" auditable.
 */
export async function amendBill(
  db: SqlDriver,
  input: { billId: string; actorId: string; now?: Date },
): Promise<CreateBillResult> {
  const source = await loadBill(db, input.billId)
  assertAmendable('bill', parseDocStatus(source.docstatus))

  const lines = await q(db)
    .select({
      productId: schema.billItems.productId,
      saleUnit: schema.billItems.saleUnit,
      qty: schema.billItems.qty,
      rate: schema.billItems.rate,
      discount: schema.billItems.discount,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, input.billId))
    .orderBy(schema.billItems.idx)

  /* Everything the original charged, to the paisa.
     The line discount was being selected and then dropped on the floor, and the
     notes were never read at all -- so amending a bill of 1,000 rupees less 100
     produced a draft for the full 1,000, with tax on the full 1,000. A shop
     correcting one line of a discounted bill handed the customer a *larger*
     bill than the one being corrected, and the discount had to be found on the
     cancelled copy and typed in again.

     ── Why the bill discount is not passed as a bill discount ──────────────
     `computeTotals` spreads a bill-level discount across the lines that may
     carry it, and `bill_items.discount` is stored as the line's own discount
     *plus* its share of that spread. The split is not recoverable from the
     stored row: the shares are apportioned by weights that are themselves
     computed from the own-discounts. So carrying the line discounts and the
     bill discount would subtract the same money twice -- 1,000 less 100 would
     amend to 900 less another 100. The first version of this did exactly that
     and the test below caught it.

     Carrying the stored line discounts alone reproduces the original exactly:
     every line's net, taxable value and tax are identical, and so is the total.
     What is not reproduced is the presentation -- the amendment shows the whole
     reduction against the lines rather than some of it on the bill. That is a
     difference in how it reads, not in what is owed, and it is the honest one
     of the two available answers.

     ── Why the posting date is not carried ─────────────────────────────────
     This is a new document raised today. Under GST there is no amended
     invoice, only a cancellation and a fresh one, so it takes today's date and
     its own number from the same series. Carrying the old date would back-date
     a document into a period that may already have been filed. `createBill`
     defaults it, so it is simply not passed. */
  const created = await createBill(db, {
    registerId: source.registerId,
    customerId: source.customerId,
    /* The order comes with it. Cancelling the original gave the order back what
       it had taken, so an amendment that dropped the link would leave the order
       open for goods the shop is about to send out again. */
    convertedFrom: source.convertedFrom,
    lines: lines.map((l) => ({
      productId: l.productId,
      saleUnit: l.saleUnit,
      qty: l.qty,
      rateOverride: l.rate,
      discount: l.discount,
    })),
    ...(source.notes !== null ? { notes: source.notes } : {}),
    actorId: input.actorId,
    ...(input.now ? { now: input.now } : {}),
  })

  if (!created.ok) return created

  await db.transaction(async (tx) => {
    await q(tx).update(schema.bills)
      .set({ amendedFrom: input.billId })
      .where(eq(schema.bills.id, created.billId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: created.billId, action: 'amend',
      after: { amended_from: input.billId },
    })
  })

  return created
}
