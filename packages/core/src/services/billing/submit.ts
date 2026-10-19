import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, ZERO, add, sub } from '../../money.js'
import { businessDate } from '../../dates.js'
import { calculateEarned, planRedemption } from '../../domain/loyalty.js'
import { DRAFT, SUBMITTED, assertCanApply, parseDocStatus } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { recheckDocStatus } from '../../integrity/transition.js'
import { nextDocNo } from '../numbering.js'
import { applyBillFulfilment } from '../documents.js'
import { loadBill, loadLoyaltyEntries, loadLoyaltyProgram, monthToDateSpend, recipientSnapshot } from './load.js'
import type { SubmitBillInput, SubmitBillResult } from './types.js'
import { assertCounterIsMine, refusedAsInvoice, refusedBelowCost, refusedOnCredit, shelfFor } from './guards.js'
import { postTenders } from './tender.js'
import { takeOffShelf } from './stock.js'
import { postVoucherGl } from '../ledger.js'

/**
 * Issues a bill: numbers it, takes the goods off the shelf and the money into
 * the drawer.
 *
 * Everything is asked inside the transaction that acts on the answer. The
 * checks used to run first and the transaction after, so the total, the
 * customer's credit and the shelf were each read once and acted on later --
 * a window two tills on one database, or a draft saved from another screen,
 * could fall into.
 *
 * Two things are decided *now* and not when the cart was started, because a
 * held bill can be started on one day and paid on another:
 *
 * - **The date.** An invoice is dated the day it is issued (Rule 46(b)); a
 *   draft is not issued. It is also the day the number's fiscal year comes
 *   from, so the two can never disagree -- they did, for a bill held over the
 *   night of 31 March.
 * - **The drawer.** The money goes into the drawer open at this counter now. It
 *   went to the one that was open when the cart was started, which by then
 *   could have been counted and closed, so the cash was in neither count.
 */
export async function submitBill(db: SqlDriver, input: SubmitBillInput): Promise<SubmitBillResult> {
  const now = input.now ?? new Date()
  const postingDate = businessDate(now)

  return db.transaction(async (tx): Promise<SubmitBillResult> => {
    if (input.idempotencyKey) {
      const [existing] = await q(tx)
        .select({
          id: schema.bills.id,
          docNo: schema.bills.docNo,
          grandTotal: schema.bills.grandTotal,
        })
        .from(schema.bills)
        .where(eq(schema.bills.idempotencyKey, input.idempotencyKey))
      if (existing) {
        return {
          ok: true, billId: existing.id, docNo: existing.docNo,
          grandTotal: existing.grandTotal,
          // A replay reports nothing new: whatever was short was said at the time.
          pointsEarned: 0, pointsRedeemed: 0, idempotent: true, shortfalls: [],
        }
      }
    }

    const bill = await loadBill(tx, input.billId)
    assertCanApply('bill', parseDocStatus(bill.docstatus), 'submit')
    await recheckDocStatus(tx, 'bills', input.billId, 'bill', 'submit')

    /* Asked here and not in `createBill`, so a cart can always be built. See
       `refusedAsInvoice` for why. */
    const unissuable = await refusedAsInvoice(tx, bill)
    if (unissuable) return unissuable

    const lines = await q(tx)
      .select({
        id: schema.billItems.id,
        idx: schema.billItems.idx,
        productId: schema.billItems.productId,
        productName: schema.billItems.productName,
        baseQty: schema.billItems.baseQty,
        batchId: schema.billItems.batchId,
        lineTotal: schema.billItems.lineTotal,
        taxableValue: schema.billItems.taxableValue,
        loyaltyBlocked: schema.billItems.loyaltyBlocked,
      })
      .from(schema.billItems)
      .where(eq(schema.billItems.billId, input.billId))
      .orderBy(schema.billItems.idx)

    const program = await loadLoyaltyProgram(tx)
    let pointsRedeemed = 0
    let redemptionValue: Money = ZERO
    let redemptionPlan: { entryId: string; points: number }[] = []

    if (input.redeemPoints && input.redeemPoints > 0) {
      if (!bill.customerId) return { ok: false, code: 'LOYALTY_REJECTED', reason: 'no customer on the bill' }
      const entries = await loadLoyaltyEntries(tx, bill.customerId)
      const plan = planRedemption(program, entries, input.redeemPoints, bill.grandTotal, now)
      if (!plan.ok) return { ok: false, code: 'LOYALTY_REJECTED', reason: plan.code }
      pointsRedeemed = plan.points
      redemptionValue = plan.value
      redemptionPlan = plan.allocations
    }

    if (input.payments.some((p) => p.amount <= 0 || p.method === 'loyalty'
      || (p.tendered !== undefined && (p.method !== 'cash' || p.tendered < p.amount)))) {
      return { ok: false, code: 'INVALID_PAYMENT' }
    }

    const received = add(...input.payments.map((p) => p.amount), redemptionValue)
    if (received !== bill.grandTotal) {
      return { ok: false, code: 'PAYMENT_MISMATCH', expected: bill.grandTotal, received }
    }

    const creditTotal = add(...input.payments.filter((p) => p.method === 'credit').map((p) => p.amount))
    if (creditTotal > 0 && !bill.customerId) return { ok: false, code: 'CREDIT_WITHOUT_CUSTOMER' }

    if (creditTotal > 0 && bill.customerId) {
      const overLimit = await refusedOnCredit(tx, bill.customerId, creditTotal)
      if (overLimit) return overLimit
    }

    const { refusal: short, shortfalls } = await shelfFor(tx, lines)
    if (short) return short

    const underCost = await refusedBelowCost(
      tx, { id: input.billId, actorId: input.actorId, allow: input.allowBelowCost === true }, lines,
    )
    if (underCost) return underCost

    // Read off the line's own flag rather than the product's, so a bill earns on
    // the rules that were in force when it was rung up.
    const earningTotal = add(
      ...lines.filter((l) => l.loyaltyBlocked !== 1).map((l) => l.lineTotal),
    )
    /* Asked only when there is a target to reach, so a shop without one pays
       nothing for it on every bill. */
    const monthToDate = program.enabled && program.monthlyTarget > 0 && bill.customerId
      ? await monthToDateSpend(tx, bill.customerId, postingDate)
      : ZERO
    const earned = calculateEarned(
      program,
      { grandTotal: bill.grandTotal, creditPortion: creditTotal, earningTotal, monthToDate },
      now,
    )
    const [register] = await q(tx)
      .select({ prefix: schema.registers.prefix })
      .from(schema.registers)
      .where(eq(schema.registers.id, bill.registerId))
    const snapshot = await recipientSnapshot(tx, bill)
    const nowIso = now.toISOString()

    // As the number is taken: a counter another till has taken since this one
    // loaded it is not one to mint on. See `assertCounterIsMine`.
    await assertCounterIsMine(tx, bill.registerId)
    const docNo = await nextDocNo(tx, 'bill', register?.prefix ?? 'XX', now)

    await takeOffShelf(tx, {
      billId: input.billId,
      postingDate,
      actorId: input.actorId,
      lines,
      batchPicks: input.batchPicks,
    })

    const sessionId = await postTenders(tx, {
      billId: input.billId,
      registerId: bill.registerId,
      customerId: bill.customerId,
      payments: input.payments,
      redemption: { value: redemptionValue, points: pointsRedeemed, plan: redemptionPlan },
      earned,
      actorId: input.actorId,
      now,
    })

    await q(tx).update(schema.bills)
      .set({
        docstatus: SUBMITTED,
        docNo,
        postingDate,
        sessionId,
        paidTotal: sub(bill.grandTotal, creditTotal),
        creditTotal,
        idempotencyKey: input.idempotencyKey ?? null,
        // The document takes its own copy of what it said, here and nowhere later.
        // `reverse_charge` keeps its default of 0: nothing in this product raises
        // a bill under reverse charge, and a column that lies about it would be
        // worse than one that does not exist.
        supplyType: snapshot.supplyType,
        customerGstin: snapshot.gstin,
        customerAddress: snapshot.address,
        customerStateCode: snapshot.stateCode,
        updatedAt: nowIso,
      })
      .where(eq(schema.bills.id, input.billId))

    /* The order is marked off here and nowhere earlier. Loading an order onto
       the counter promises nothing; taking the money is the delivery. */
    if (bill.convertedFrom) {
      await applyBillFulfilment(tx, {
        billId: input.billId,
        documentId: bill.convertedFrom,
        actorId: input.actorId,
        now,
      })
    }

    // The books, in the same transaction: a bill whose entries would not balance is not issued.
    await postVoucherGl(tx, 'bill', input.billId)

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: input.billId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      before: { doc_no: bill.docNo, posting_date: bill.postingDate },
      after: { doc_no: docNo, posting_date: postingDate },
    })

    return {
      ok: true,
      billId: input.billId,
      docNo,
      grandTotal: bill.grandTotal,
      pointsEarned: earned.points,
      pointsRedeemed,
      idempotent: false,
      shortfalls,
    }
  })
}
