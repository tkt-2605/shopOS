import { eq, and } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, paise, add, sub } from '../../money.js'
import { type Qty, qty, addQty, subQty } from '../../quantity.js'
import { splitTax, supplyTypeFor } from '../../domain/tax.js'
import { splitRefund, type RefundSplit } from '../../domain/returns.js'
import { SUBMITTED } from '../../integrity/docstatus.js'
import { getSetting } from '../settings.js'
import { outstandingOn, refundBasis, refundedSoFar } from './refund.js'
import type { CreateReturnResult, ReturnLineInput } from './types.js'

/*
 * What each line of a return gives back, worked out from what the bill
 * actually charged, and the preview a screen shows before anything is posted.
 */

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
/**
 * One entry per bill line. The same line named twice -- three and three of a
 * line of five -- passes the returnable check once each and returns six.
 */
function mergeLines(lines: ReturnLineInput[]): ReturnLineInput[] {
  const merged = new Map<string, ReturnLineInput>()
  for (const line of lines) {
    const at = merged.get(line.billItemId)
    merged.set(line.billItemId, at ? { ...at, qty: addQty(at.qty, line.qty) } : { ...line })
  }
  return [...merged.values()]
}

export async function computeLines(
  db: SqlDriver,
  billId: string,
  lines: ReturnLineInput[],
): Promise<ComputeResult> {
  if (lines.length === 0) return { ok: false, code: 'NO_LINES' }
  lines = mergeLines(lines)

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
