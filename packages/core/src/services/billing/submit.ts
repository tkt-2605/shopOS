import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, ZERO, add, sub } from '../../money.js'
import { calculateEarned, planRedemption } from '../../domain/loyalty.js'
import { DRAFT, SUBMITTED, assertCanApply, parseDocStatus } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { recheckDocStatus } from '../../integrity/transition.js'
import { loadStockPolicy } from '../features.js'
import { nextDocNo } from '../numbering.js'
import { applyBillFulfilment } from '../documents.js'
import { loadBill, loadLoyaltyEntries, loadLoyaltyProgram, recipientSnapshot } from './load.js'
import type { SubmitBillInput, SubmitBillResult } from './types.js'
import { refusedAsInvoice, refusedOnCredit } from './guards.js'
import { postTenders } from './tender.js'
import { shortfallsOf, takeOffShelf } from './stock.js'

export async function submitBill(db: SqlDriver, input: SubmitBillInput): Promise<SubmitBillResult> {
  const now = input.now ?? new Date()

  if (input.idempotencyKey) {
    const [existing] = await q(db)
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

  const bill = await loadBill(db, input.billId)
  assertCanApply('bill', parseDocStatus(bill.docstatus), 'submit')

  /* Asked here and not in `createBill`, so a cart can always be built. See
     `refusedAsInvoice` for why. */
  const unissuable = await refusedAsInvoice(db, bill)
  if (unissuable) return unissuable

  const lines = await q(db)
    .select({
      id: schema.billItems.id,
      idx: schema.billItems.idx,
      productId: schema.billItems.productId,
      productName: schema.billItems.productName,
      baseQty: schema.billItems.baseQty,
      lineTotal: schema.billItems.lineTotal,
      loyaltyBlocked: schema.billItems.loyaltyBlocked,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, input.billId))
    .orderBy(schema.billItems.idx)

  const program = await loadLoyaltyProgram(db)
  let pointsRedeemed = 0
  let redemptionValue: Money = ZERO
  let redemptionPlan: { entryId: string; points: number }[] = []

  if (input.redeemPoints && input.redeemPoints > 0) {
    if (!bill.customerId) return { ok: false, code: 'LOYALTY_REJECTED', reason: 'no customer on the bill' }
    const entries = await loadLoyaltyEntries(db, bill.customerId)
    const plan = planRedemption(program, entries, input.redeemPoints, bill.grandTotal, now)
    if (!plan.ok) return { ok: false, code: 'LOYALTY_REJECTED', reason: plan.code }
    pointsRedeemed = plan.points
    redemptionValue = plan.value
    redemptionPlan = plan.allocations
  }

  if (input.payments.some((p) => p.amount <= 0 || p.method === 'loyalty')) {
    return { ok: false, code: 'INVALID_PAYMENT' }
  }

  const received = add(...input.payments.map((p) => p.amount), redemptionValue)
  if (received !== bill.grandTotal) {
    return { ok: false, code: 'PAYMENT_MISMATCH', expected: bill.grandTotal, received }
  }

  const creditTotal = add(...input.payments.filter((p) => p.method === 'credit').map((p) => p.amount))
  if (creditTotal > 0 && !bill.customerId) return { ok: false, code: 'CREDIT_WITHOUT_CUSTOMER' }

  if (creditTotal > 0 && bill.customerId) {
    const overLimit = await refusedOnCredit(db, bill.customerId, creditTotal)
    if (overLimit) return overLimit
  }

  /* The check is the same as it always was; what changed is who it binds.
     Under `block` a short line still refuses the sale. Otherwise the sale goes
     through and the shortfall is reported back on the result, so the counter can
     say what happened and the shortfall report can pick it up afterwards. */
  const shortfalls = await shortfallsOf(db, lines)
  if (shortfalls.length > 0 && await loadStockPolicy(db) === 'block') {
    return { ok: false, code: 'INSUFFICIENT_STOCK', shortfalls }
  }

  // Read off the line's own flag rather than the product's, so a bill earns on
  // the rules that were in force when it was rung up.
  const earningTotal = add(
    ...lines.filter((l) => l.loyaltyBlocked !== 1).map((l) => l.lineTotal),
  )
  const earned = calculateEarned(
    program,
    { grandTotal: bill.grandTotal, creditPortion: creditTotal, earningTotal },
    now,
  )
  const [register] = await q(db)
    .select({ prefix: schema.registers.prefix })
    .from(schema.registers)
    .where(eq(schema.registers.id, bill.registerId))
  const snapshot = await recipientSnapshot(db, bill)
  const nowIso = now.toISOString()
  let docNo = ''

  await db.transaction(async (tx) => {
    await recheckDocStatus(tx, 'bills', input.billId, 'bill', 'submit')
    docNo = await nextDocNo(tx, 'bill', register?.prefix ?? 'XX', now)

    await takeOffShelf(tx, {
      billId: input.billId,
      postingDate: bill.postingDate,
      actorId: input.actorId,
      lines,
      batchPicks: input.batchPicks,
    })

    await postTenders(tx, {
      billId: input.billId,
      sessionId: bill.sessionId,
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

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: input.billId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      before: { doc_no: bill.docNo }, after: { doc_no: docNo },
    })
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
}
