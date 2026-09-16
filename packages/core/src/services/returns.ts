import { eq, and, gt, isNull, desc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { businessDate } from '../dates.js'
import { newId } from '../ids.js'
import { type Money, ZERO, paise, add, sub } from '../money.js'
import { QTY_SCALE, type Qty, qty, addQty, subQty } from '../quantity.js'
import { splitTax, supplyTypeFor } from '../domain/tax.js'
import { splitRefund, type RefundBasis, type RefundSplit } from '../domain/returns.js'
import { DRAFT, SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { postMovement, reverseVoucher, issuedUnitCost } from './stock.js'
import { nextDocNo } from './numbering.js'
import { openSessionFor, postCashMovement } from './cash.js'
import { postCreditNote } from './payments.js'
import { getSetting } from './bootstrap.js'

/**
 * A return, and everything it has to undo.
 *
 * The whole decision, written once so the screen and the service cannot disagree
 * about it:
 *
 *   **The refund is what was paid, not what was listed.** `bill_items.line_total`
 *   is already net of the line's own discount and of its share of the bill-level
 *   one, so a half-price item comes back at half price. Refunding the list price
 *   on a discounted bill loses the discount a second time.
 *
 *   **The discount is not re-spread.** Returning one line of a discounted bill
 *   leaves the other lines' shares alone. Re-spreading would change the price of
 *   goods the customer is keeping, on an invoice already printed and filed.
 *
 *   **The last return on a line pays out the remainder** rather than a fresh
 *   percentage, so successive partial returns sum back to the line exactly.
 *
 *   **The refund comes back in the currencies it was paid in** — see
 *   `domain/returns.ts`. Points that paid for goods come back as points.
 *
 *   **Points the sale earned come off**, in proportion, but never below what the
 *   customer has already spent elsewhere. Those are gone, and a negative balance
 *   is worse than the shop absorbing the difference.
 *
 *   **An item marked no-return is refused** before anything is written, and an
 *   item marked no-loyalty earned nothing to take back in the first place.
 *
 *   **The money comes out of today's drawer**, not the one that was open when the
 *   bill was rung up — that session has been counted and closed.
 */

export type RefundMethod = 'cash' | 'upi' | 'card' | 'credit'

export interface ReturnLineInput {
  billItemId: string
  qty: Qty
}

export interface CreateReturnInput {
  billId: string
  lines: ReturnLineInput[]
  refundMethod: RefundMethod
  reason?: string
  actorId: string
  now?: Date
}

export type CreateReturnResult =
  | { ok: true; returnId: string; refundTotal: Money; taxReversed: Money; lineCount: number }
  | { ok: false; code: 'NO_LINES' }
  | { ok: false; code: 'BILL_NOT_SUBMITTED' }
  | { ok: false; code: 'UNKNOWN_LINE'; billItemId: string }
  | { ok: false; code: 'EXCEEDS_RETURNABLE'; billItemId: string; requested: Qty; returnable: Qty }
  | { ok: false; code: 'RETURN_BLOCKED'; productName: string }

export interface ReturnOutcome {
  returnId: string
  docNo: string
  /** The value of the goods. What the credit note reverses. */
  refundTotal: Money
  /** What left the drawer, or went onto the khata. */
  refundCash: Money
  pointsRestored: number
  pointsClawedBack: number
  creditNoteDocNo: string | null
}

export type SubmitReturnResult =
  | ({ ok: true } & ReturnOutcome)
  | { ok: false; code: 'BILL_CANCELLED' }
  | { ok: false; code: 'NOTHING_TO_CREDIT'; refund: Money; outstanding: Money }

export type ProcessReturnResult =
  | ({ ok: true } & ReturnOutcome)
  | Exclude<CreateReturnResult, { ok: true }>
  | Exclude<SubmitReturnResult, { ok: true }>

interface ComputedReturnLine {
  billItemId: string
  productId: string
  productName: string
  qty: Qty
  baseQty: Qty
  refund: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  /* Rule 53 wants the credit note to carry the same HSN and rate as the line it
     reverses. Copied off the bill line, never off the product, because the rate
     on the product today is not the rate that was charged. */
  hsnCode: string | null
  taxRateBp: number
}

type ComputeResult =
  | { ok: true; lines: ComputedReturnLine[]; refundTotal: Money; taxReversed: Money }
  | Exclude<CreateReturnResult, { ok: true }>

/**
 * What the lines come to, without writing anything.
 *
 * Shared by the preview the screen shows and the return the service writes, so
 * the figure the cashier reads out to the customer is the figure that is paid.
 */
async function computeLines(
  db: SqlDriver,
  billId: string,
  lines: ReturnLineInput[],
): Promise<ComputeResult> {
  if (lines.length === 0) return { ok: false, code: 'NO_LINES' }

  const [bill] = await q(db)
    .select({
      id: schema.bills.id,
      docstatus: schema.bills.docstatus,
      placeOfSupply: schema.bills.placeOfSupply,
      supplyType: schema.bills.supplyType,
    })
    .from(schema.bills)
    .where(eq(schema.bills.id, billId))
  if (!bill) throw new Error(`unknown bill: ${billId}`)
  if (bill.docstatus !== SUBMITTED) return { ok: false, code: 'BILL_NOT_SUBMITTED' }

  /* A credit note reverses tax the shop has already charged and already filed,
     so it has to reverse the tax that was charged — not the tax the same goods
     would attract if they were sold again today.

     This used to re-derive the supply type from the shop's current state setting
     and the customer's state, which is a different question with a different
     answer: a shop that corrects its own state code, or a customer moved to the
     right state after the sale, would have found IGST credited back against
     CGST+SGST collected, and the difference would have sat in the return
     unexplained. The bill says what it was. Rule 53 asks for exactly that. */
  const supply = bill.supplyType === 'inter_state' || bill.supplyType === 'intra_state'
    ? bill.supplyType
    // Only for a bill submitted before migration 028 backfilled it, which the
    // migration leaves none of. Deriving is what this did before, so a gap here
    // is no worse than the behaviour it replaces.
    : supplyTypeFor(await getSetting(db, 'shop_state_code'), bill.placeOfSupply)

  const computed: ComputedReturnLine[] = []

  for (const line of lines) {
    const [item] = await q(db)
      .select({
        id: schema.billItems.id,
        productId: schema.billItems.productId,
        productName: schema.billItems.productName,
        qty: schema.billItems.qty,
        baseQty: schema.billItems.baseQty,
        returnedQty: schema.billItems.returnedQty,
        lineTotal: schema.billItems.lineTotal,
        taxRateBp: schema.billItems.taxRateBp,
        hsnCode: schema.billItems.hsnCode,
      })
      .from(schema.billItems)
      .where(and(eq(schema.billItems.id, line.billItemId), eq(schema.billItems.billId, billId)))
    if (!item) return { ok: false, code: 'UNKNOWN_LINE', billItemId: line.billItemId }

    const [blocked] = await q(db)
      .select({ name: schema.products.name, returnBlocked: schema.products.returnBlocked })
      .from(schema.products)
      .where(eq(schema.products.id, item.productId))
    if (blocked?.returnBlocked === 1) return { ok: false, code: 'RETURN_BLOCKED', productName: blocked.name }

    const returnable = subQty(item.qty, item.returnedQty)
    if (line.qty <= 0 || line.qty > returnable) {
      return { ok: false, code: 'EXCEEDS_RETURNABLE', billItemId: line.billItemId, requested: line.qty, returnable }
    }

    // A return that finishes the line refunds whatever is left rather than a fresh
    // percentage, so successive partial returns always sum back to the line total.
    const alreadyRefunded = await refundedSoFar(db, item.id)
    const completesLine = addQty(item.returnedQty, line.qty) === item.qty
    const refund = completesLine
      ? sub(item.lineTotal, alreadyRefunded)
      : paise(Math.round((item.lineTotal * line.qty) / item.qty))

    // Splitting tax out of the refund keeps each credit note internally consistent:
    // taxable + cgst + sgst equals the refund exactly, as on the original invoice.
    const tax = splitTax(refund, item.taxRateBp, supply)

    computed.push({
      billItemId: item.id,
      productId: item.productId,
      productName: item.productName,
      qty: line.qty,
      baseQty: qty(Math.round((item.baseQty * line.qty) / item.qty)),
      hsnCode: item.hsnCode,
      taxRateBp: item.taxRateBp,
      refund,
      taxableValue: tax.taxableValue,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
    })
  }

  return {
    ok: true,
    lines: computed,
    refundTotal: add(...computed.map((l) => l.refund)),
    taxReversed: add(...computed.map((l) => add(l.cgst, l.sgst, l.igst))),
  }
}

export interface ReturnPreview extends RefundSplit {
  taxReversed: Money
  lines: { billItemId: string; productName: string; qty: Qty; refund: Money }[]
  /** What the customer still owes on this bill, if anything. */
  outstanding: Money
}

export type PreviewReturnResult =
  | ({ ok: true } & ReturnPreview)
  | Exclude<CreateReturnResult, { ok: true }>

/** What would happen, shown before it does. Writes nothing. */
export async function previewReturn(
  db: SqlDriver,
  input: { billId: string; lines: ReturnLineInput[] },
): Promise<PreviewReturnResult> {
  const computed = await computeLines(db, input.billId, input.lines)
  if (!computed.ok) return computed

  const split = splitRefund(computed.refundTotal, await refundBasis(db, input.billId))

  return {
    ok: true,
    ...split,
    taxReversed: computed.taxReversed,
    lines: computed.lines.map((l) => ({
      billItemId: l.billItemId, productName: l.productName, qty: l.qty, refund: l.refund,
    })),
    outstanding: await outstandingOn(db, input.billId),
  }
}

export async function createReturn(db: SqlDriver, input: CreateReturnInput): Promise<CreateReturnResult> {
  const computed = await computeLines(db, input.billId, input.lines)
  if (!computed.ok) return computed

  const now = input.now ?? new Date()
  const returnId = newId()
  const nowIso = now.toISOString()
  const postingDate = businessDate(now)

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.salesReturns).values({
      id: returnId,
      docNo: `DRAFT-${returnId}`,
      docstatus: DRAFT,
      billId: input.billId,
      postingDate,
      refundTotal: computed.refundTotal,
      taxReversed: computed.taxReversed,
      refundMethod: input.refundMethod,
      reason: input.reason ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    for (const line of computed.lines) {
      await q(tx).insert(schema.salesReturnItems).values({
        id: newId(),
        returnId,
        billItemId: line.billItemId,
        productId: line.productId,
        qty: line.qty,
        baseQty: line.baseQty,
        refundAmount: line.refund,
        taxableValue: line.taxableValue,
        cgstAmount: line.cgst,
        sgstAmount: line.sgst,
        igstAmount: line.igst,
        hsnCode: line.hsnCode,
        taxRateBp: line.taxRateBp,
      })
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: returnId, action: 'create', docstatusTo: DRAFT,
    })
  })

  return {
    ok: true,
    returnId,
    refundTotal: computed.refundTotal,
    taxReversed: computed.taxReversed,
    lineCount: computed.lines.length,
  }
}

/**
 * A return is taken complete, the way a receipt is.
 *
 * There is no half-made return to come back to: the customer is standing at the
 * counter holding the goods. The draft step still exists underneath — the
 * document has a docstatus and a cancel path — but nobody is asked to walk it.
 */
export async function processReturn(db: SqlDriver, input: CreateReturnInput): Promise<ProcessReturnResult> {
  const created = await createReturn(db, input)
  if (!created.ok) return created

  const submitted = await submitReturn(db, {
    returnId: created.returnId,
    actorId: input.actorId,
    ...(input.now ? { now: input.now } : {}),
  })

  // A refusal at submit would otherwise leave a draft nobody will ever finish,
  // silting the bill up with returns that did not happen.
  if (!submitted.ok) {
    await q(db).delete(schema.salesReturnItems)
      .where(eq(schema.salesReturnItems.returnId, created.returnId))
    await q(db).delete(schema.salesReturns)
      .where(eq(schema.salesReturns.id, created.returnId))
  }
  return submitted
}

export async function submitReturn(
  db: SqlDriver,
  input: { returnId: string; actorId: string; now?: Date },
): Promise<SubmitReturnResult> {
  const now = input.now ?? new Date()
  const ret = await loadReturn(db, input.returnId)
  assertCanApply('return', parseDocStatus(ret.docstatus), 'submit')

  const [bill] = await q(db)
    .select({
      docstatus: schema.bills.docstatus,
      registerId: schema.bills.registerId,
      customerId: schema.bills.customerId,
      grandTotal: schema.bills.grandTotal,
      postingDate: schema.bills.postingDate,
      docNo: schema.bills.docNo,
    })
    .from(schema.bills)
    .where(eq(schema.bills.id, ret.billId))
  if (!bill || bill.docstatus !== SUBMITTED) return { ok: false, code: 'BILL_CANCELLED' }

  const split = splitRefund(ret.refundTotal, await refundBasis(db, ret.billId))

  // A refund onto the account can only take off what is owed. This product has
  // no store-credit wallet, and inventing one here would leave money sitting
  // somewhere no screen adds up. Cash, or a smaller return.
  if (ret.refundMethod === 'credit' && split.cash > 0) {
    if (!bill.customerId) return { ok: false, code: 'NOTHING_TO_CREDIT', refund: split.cash, outstanding: ZERO }
    const outstanding = await outstandingFor(db, bill.customerId)
    if (outstanding < split.cash) {
      return { ok: false, code: 'NOTHING_TO_CREDIT', refund: split.cash, outstanding }
    }
  }

  const lines = await q(db)
    .select({
      billItemId: schema.salesReturnItems.billItemId,
      productId: schema.salesReturnItems.productId,
      qty: schema.salesReturnItems.qty,
      baseQty: schema.salesReturnItems.baseQty,
    })
    .from(schema.salesReturnItems)
    .where(eq(schema.salesReturnItems.returnId, input.returnId))

  const [register] = await q(db)
    .select({ prefix: schema.registers.prefix })
    .from(schema.registers)
    .where(eq(schema.registers.id, bill.registerId))
  const nowIso = now.toISOString()
  let docNo = ''
  let creditNoteDocNo: string | null = null

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'return', register?.prefix ?? 'XX', now)

    for (const line of lines) {
      await postMovement(tx, {
        productId: line.productId,
        qtyChange: line.baseQty,
        unitCost: await issuedUnitCost(tx, 'bill', ret.billId, line.productId),
        voucherType: 'sales_return',
        voucherId: input.returnId,
        postingDate: ret.postingDate,
        userId: input.actorId,
      })
      /* Read-modify-write in one statement rather than two: the figure this
         adds to is the one the other till may be adding to at the same moment. */
      await q(tx).update(schema.billItems)
        .set({ returnedQty: sql`${schema.billItems.returnedQty} + ${line.qty}` })
        .where(eq(schema.billItems.id, line.billItemId))
    }

    if (split.cash > 0) {
      if (ret.refundMethod === 'credit') {
        const note = await postCreditNote(tx, {
          customerId: bill.customerId!,
          amount: split.cash,
          reference: `${docNo} against ${bill.docNo}`,
          notes: ret.reason,
          ...(register?.prefix ? { registerPrefix: register.prefix } : {}),
          actorId: input.actorId,
          now,
        })
        creditNoteDocNo = note.docNo
        await q(tx).update(schema.salesReturns)
          .set({ creditNoteId: note.paymentId })
          .where(eq(schema.salesReturns.id, input.returnId))
      } else {
        // Out of whichever drawer is open now — a return days later must not
        // reach back into a session that has been counted and closed.
        const session = await openSessionFor(tx, bill.registerId)
        if (session) {
          await postCashMovement(tx, {
            sessionId: session,
            direction: 'out',
            amount: split.cash,
            method: ret.refundMethod,
            sourceType: 'sales_return',
            sourceId: input.returnId,
            userId: input.actorId,
            now,
          })
        }
      }
    }

    if (split.pointsRestored > 0) await restorePoints(tx, ret.billId, split.pointsRestored)
    if (split.pointsRemoved > 0) await clawBackPoints(tx, ret.billId, split.pointsRemoved, nowIso)

    await q(tx).update(schema.salesReturns)
      .set({
        docstatus: SUBMITTED,
        docNo,
        refundCash: split.cash,
        pointsRestored: split.pointsRestored,
        pointsRemoved: split.pointsRemoved,
        updatedAt: nowIso,
      })
      .where(eq(schema.salesReturns.id, input.returnId))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: input.returnId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      before: { doc_no: ret.docNo },
      after: {
        doc_no: docNo,
        refund_cash: split.cash,
        points_restored: split.pointsRestored,
        points_removed: split.pointsRemoved,
      },
    })
  })

  return {
    ok: true,
    returnId: input.returnId,
    docNo,
    refundTotal: ret.refundTotal,
    refundCash: split.cash,
    pointsRestored: split.pointsRestored,
    pointsClawedBack: split.pointsRemoved,
    creditNoteDocNo,
  }
}

export async function cancelReturn(
  db: SqlDriver,
  input: { returnId: string; reason?: string; actorId: string; now?: Date },
): Promise<{ ok: true; returnId: string }> {
  const now = input.now ?? new Date()
  const ret = await loadReturn(db, input.returnId)
  assertCanApply('return', parseDocStatus(ret.docstatus), 'cancel')

  const lines = await q(db)
    .select({ billItemId: schema.salesReturnItems.billItemId, qty: schema.salesReturnItems.qty })
    .from(schema.salesReturnItems)
    .where(eq(schema.salesReturnItems.returnId, input.returnId))
  const nowIso = now.toISOString()

  await db.transaction(async (tx) => {
    await reverseVoucher(tx, 'sales_return', input.returnId, ret.postingDate, input.actorId)

    for (const line of lines) {
      await q(tx).update(schema.billItems)
        .set({ returnedQty: sql`${schema.billItems.returnedQty} - ${line.qty}` })
        .where(eq(schema.billItems.id, line.billItemId))
    }

    // Everything the return handed back is taken back, in the same currencies.
    if (ret.creditNoteId) {
      await q(tx).update(schema.paymentEntries)
        .set({ docstatus: CANCELLED, updatedAt: nowIso })
        .where(eq(schema.paymentEntries.id, ret.creditNoteId))
      await writeAudit(tx, { actorId: input.actorId }, {
        entity: 'payment_entries', entityId: ret.creditNoteId, action: 'cancel',
        docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
        after: { cancel_reason: `${ret.docNo} cancelled` },
      })
    }
    if (ret.pointsRestored > 0) await unrestorePoints(tx, ret.billId, ret.pointsRestored)
    if (ret.pointsRemoved > 0) await regrantPoints(tx, ret.billId, ret.pointsRemoved)

    await q(tx).update(schema.salesReturns)
      .set({ docstatus: CANCELLED, updatedAt: nowIso })
      .where(eq(schema.salesReturns.id, input.returnId))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: input.returnId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, returnId: input.returnId }
}

/**
 * What this bill has paid back already, and in what.
 *
 * Cumulative rather than per-return, because that is what makes the last return
 * hand back the exact remainder instead of a rounded share of it.
 */
async function refundBasis(db: SqlDriver, billId: string): Promise<RefundBasis> {
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
async function restorePoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
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
async function unrestorePoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
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
async function clawBackPoints(tx: SqlDriver, billId: string, points: number, nowIso: string): Promise<void> {
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

async function regrantPoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
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

async function refundedSoFar(db: SqlDriver, billItemId: string): Promise<Money> {
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

/* raw: a correlated subquery, which the query builder has no shape for.
   Joining to the allocations instead would repeat the bill row once per payment
   against it, so a bill settled in instalments would count its own credit total
   once per instalment. `bills.id` is written out rather than interpolated
   because Drizzle renders a column reference unqualified inside a subquery,
   where a bare `id` binds to the allocation tables first. */
const ALLOCATED = sql`COALESCE((
  SELECT SUM(pa.amount) FROM payment_allocations pa
    JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = ${SUBMITTED}
   WHERE pa.bill_id = bills.id), 0)`

/** What is still owed on one bill. */
async function outstandingOn(db: SqlDriver, billId: string): Promise<Money> {
  const [row] = await q(db)
    .select({ due: sql<number>`${schema.bills.creditTotal} - ${ALLOCATED}` })
    .from(schema.bills)
    .where(eq(schema.bills.id, billId))
  return paise(Math.max(0, row?.due ?? 0))
}

/** What is still owed across every bill of one customer. */
async function outstandingFor(db: SqlDriver, customerId: string): Promise<Money> {
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

export interface ReturnListItem {
  id: string
  docNo: string
  docstatus: number
  postingDate: string
  refundTotal: Money
  refundCash: Money
  pointsRestored: number
  refundMethod: RefundMethod
  reason: string | null
}

export interface ReturnDetailItem {
  productName: string
  saleUnit: string
  qty: Qty
  /** What one unit was refunded at, back out of the refund and the quantity. */
  rate: Money
  refund: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  hsnCode: string | null
  taxRateBp: number
}

/**
 * A credit note, with everything Rule 53 says has to be on one.
 *
 * The rule is short and every clause of it is a field here: the supplier's
 * details, a serial number, the date, the recipient's details, **the invoice it
 * is raised against and that invoice's date**, the taxable value and the tax
 * credited, and a signature.
 *
 * The recipient and the supply type come off the bill's 028 snapshot rather
 * than off `customers`, for the reason the snapshot exists: a credit note is a
 * document that has been issued, and it has to keep saying what it said.
 */
export interface ReturnDetail {
  id: string
  docNo: string
  docstatus: number
  postingDate: string
  refundTotal: Money
  refundCash: Money
  refundMethod: RefundMethod
  reason: string | null
  taxReversed: Money

  /** Rule 53(1)(e): the invoice, and its date. */
  billId: string
  againstDocNo: string
  againstDate: string

  customerName: string | null
  customerAddress: string | null
  customerGstin: string | null
  customerStateCode: string | null
  placeOfSupply: string | null
  supplyType: 'intra_state' | 'inter_state' | null

  createdBy: string | null
  items: ReturnDetailItem[]
}

/** One return, whole, for the credit note print and the screen that offers it. */
export async function loadReturnDetail(db: SqlDriver, returnId: string): Promise<ReturnDetail | null> {
  const [head] = await q(db)
    .select({
      id: schema.salesReturns.id,
      docNo: schema.salesReturns.docNo,
      docstatus: schema.salesReturns.docstatus,
      postingDate: schema.salesReturns.postingDate,
      refundTotal: schema.salesReturns.refundTotal,
      refundCash: schema.salesReturns.refundCash,
      refundMethod: schema.salesReturns.refundMethod,
      reason: schema.salesReturns.reason,
      taxReversed: schema.salesReturns.taxReversed,
      billId: schema.salesReturns.billId,
      username: schema.users.username,
      againstDocNo: schema.bills.docNo,
      againstDate: schema.bills.postingDate,
      customerName: schema.bills.customerName,
      customerAddress: schema.bills.customerAddress,
      customerGstin: schema.bills.customerGstin,
      customerStateCode: schema.bills.customerStateCode,
      placeOfSupply: schema.bills.placeOfSupply,
      supplyType: schema.bills.supplyType,
    })
    .from(schema.salesReturns)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    /* Left, because the user who took the return may since have been removed
       from the shop, and a credit note that stops loading for that reason is a
       document the shop cannot reprint. */
    .leftJoin(schema.users, eq(schema.users.id, schema.salesReturns.createdBy))
    .where(eq(schema.salesReturns.id, returnId))
  if (!head) return null

  /* The unit is on the bill line, not on the return line: a return records how
     many came back, and what one of them is called is the invoice's answer.
     Joined rather than duplicated for that reason. */
  const rows = await q(db)
    .select({
      productName: schema.billItems.productName,
      saleUnit: schema.billItems.saleUnit,
      qty: schema.salesReturnItems.qty,
      refundAmount: schema.salesReturnItems.refundAmount,
      taxableValue: schema.salesReturnItems.taxableValue,
      cgstAmount: schema.salesReturnItems.cgstAmount,
      sgstAmount: schema.salesReturnItems.sgstAmount,
      igstAmount: schema.salesReturnItems.igstAmount,
      hsnCode: schema.salesReturnItems.hsnCode,
      taxRateBp: schema.salesReturnItems.taxRateBp,
    })
    .from(schema.salesReturnItems)
    .innerJoin(schema.billItems, eq(schema.billItems.id, schema.salesReturnItems.billItemId))
    .where(eq(schema.salesReturnItems.returnId, returnId))

  /* `username` is pulled out rather than spread through: the field this
     document carries is `createdBy`, and leaving both on the object would put a
     second name for the same thing into every caller. */
  const { username, ...rest } = head

  return {
    ...rest,
    refundMethod: head.refundMethod as RefundMethod,
    supplyType: head.supplyType === 'inter_state' || head.supplyType === 'intra_state'
      ? head.supplyType
      : null,
    createdBy: username,
    items: rows.map((r) => ({
      productName: r.productName,
      saleUnit: r.saleUnit,
      qty: r.qty,
      // Back out of the refund and the quantity, never off the product: this is
      // what the goods were credited at, which is what the invoice charged.
      rate: paise(r.qty === 0 ? 0 : Math.round((r.refundAmount * QTY_SCALE) / r.qty)),
      refund: r.refundAmount,
      taxableValue: r.taxableValue,
      cgst: r.cgstAmount,
      sgst: r.sgstAmount,
      igst: r.igstAmount,
      hsnCode: r.hsnCode,
      taxRateBp: r.taxRateBp,
    })),
  }
}

/** The returns already taken against a bill, for the screen that shows it. */
export async function listReturns(db: SqlDriver, billId: string): Promise<ReturnListItem[]> {
  const rows = await q(db)
    .select({
      id: schema.salesReturns.id,
      docNo: schema.salesReturns.docNo,
      docstatus: schema.salesReturns.docstatus,
      postingDate: schema.salesReturns.postingDate,
      refundTotal: schema.salesReturns.refundTotal,
      refundCash: schema.salesReturns.refundCash,
      pointsRestored: schema.salesReturns.pointsRestored,
      refundMethod: schema.salesReturns.refundMethod,
      reason: schema.salesReturns.reason,
    })
    .from(schema.salesReturns)
    .where(eq(schema.salesReturns.billId, billId))
    .orderBy(desc(schema.salesReturns.createdAt))

  return rows.map((r) => ({ ...r, refundMethod: r.refundMethod as RefundMethod }))
}

interface ReturnRow {
  id: string
  docNo: string
  docstatus: number
  billId: string
  postingDate: string
  refundTotal: Money
  refundMethod: RefundMethod
  reason: string | null
  creditNoteId: string | null
  pointsRestored: number
  pointsRemoved: number
}

async function loadReturn(db: SqlDriver, returnId: string): Promise<ReturnRow> {
  const [row] = await q(db)
    .select({
      id: schema.salesReturns.id,
      docNo: schema.salesReturns.docNo,
      docstatus: schema.salesReturns.docstatus,
      billId: schema.salesReturns.billId,
      postingDate: schema.salesReturns.postingDate,
      refundTotal: schema.salesReturns.refundTotal,
      refundMethod: schema.salesReturns.refundMethod,
      reason: schema.salesReturns.reason,
      creditNoteId: schema.salesReturns.creditNoteId,
      pointsRestored: schema.salesReturns.pointsRestored,
      pointsRemoved: schema.salesReturns.pointsRemoved,
    })
    .from(schema.salesReturns)
    .where(eq(schema.salesReturns.id, returnId))
  if (!row) throw new Error(`unknown return: ${returnId}`)
  return { ...row, refundMethod: row.refundMethod as RefundMethod }
}

export async function returnableQty(db: SqlDriver, billItemId: string): Promise<Qty> {
  const [row] = await q(db)
    .select({ qty: schema.billItems.qty, returnedQty: schema.billItems.returnedQty })
    .from(schema.billItems)
    .where(eq(schema.billItems.id, billItemId))
  if (!row) return qty(0)
  return subQty(row.qty, row.returnedQty)
}

export const ZERO_REFUND = ZERO
