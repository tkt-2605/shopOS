import { eq, desc } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, paise } from '../../money.js'
import { QTY_SCALE, type Qty, qty, subQty } from '../../quantity.js'
import type { RefundMethod } from './types.js'

/*
 * Returns as a screen reads them: the list, one return in full, and how much
 * of a bill line is still returnable.
 */

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

export async function loadReturn(db: SqlDriver, returnId: string): Promise<ReturnRow> {
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
