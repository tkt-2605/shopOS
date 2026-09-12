import type { SqlDriver } from '../db/driver.js'
import { businessDate } from '../dates.js'
import { newId } from '../ids.js'
import { type Money, ZERO, paise, add, sub } from '../money.js'
import { type Qty, qty, addQty, subQty } from '../quantity.js'
import { splitTax, supplyTypeFor } from '../domain/tax.js'
import { DRAFT, SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { postMovement, reverseVoucher, issuedUnitCost } from './stock.js'
import { nextDocNo } from './numbering.js'
import { openSessionFor, postCashMovement } from './cash.js'
import { getSetting } from './bootstrap.js'

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

export type SubmitReturnResult =
  | { ok: true; returnId: string; docNo: string; refundTotal: Money; pointsClawedBack: number }
  | { ok: false; code: 'BILL_CANCELLED' }

interface ComputedReturnLine {
  billItemId: string
  productId: string
  qty: Qty
  baseQty: Qty
  refund: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
}

export async function createReturn(db: SqlDriver, input: CreateReturnInput): Promise<CreateReturnResult> {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }

  const now = input.now ?? new Date()
  const bill = await db.get<{ id: string; docstatus: number; place_of_supply: string | null }>(
    `SELECT id, docstatus, place_of_supply FROM bills WHERE id = ?`,
    [input.billId],
  )
  if (!bill) throw new Error(`unknown bill: ${input.billId}`)
  if (bill.docstatus !== SUBMITTED) return { ok: false, code: 'BILL_NOT_SUBMITTED' }

  const shopState = await getSetting(db, 'shop_state_code')
  const supply = supplyTypeFor(shopState, bill.place_of_supply)

  const computed: ComputedReturnLine[] = []

  for (const line of input.lines) {
    const item = await db.get<{
      id: string; product_id: string; qty: number; base_qty: number; returned_qty: number
      line_total: number; tax_rate_bp: number
    }>(
      `SELECT id, product_id, qty, base_qty, returned_qty, line_total, tax_rate_bp
         FROM bill_items WHERE id = ? AND bill_id = ?`,
      [line.billItemId, input.billId],
    )
    if (!item) return { ok: false, code: 'UNKNOWN_LINE', billItemId: line.billItemId }

    const blocked = await db.get<{ name: string; return_blocked: number }>(
      `SELECT name, return_blocked FROM products WHERE id = ?`,
      [item.product_id],
    )
    if (blocked?.return_blocked === 1) return { ok: false, code: 'RETURN_BLOCKED', productName: blocked.name }

    const returnable = subQty(qty(item.qty), qty(item.returned_qty))
    if (line.qty <= 0 || line.qty > returnable) {
      return { ok: false, code: 'EXCEEDS_RETURNABLE', billItemId: line.billItemId, requested: line.qty, returnable }
    }

    // A return that finishes the line refunds whatever is left rather than a fresh
    // percentage, so successive partial returns always sum back to the line total.
    const alreadyRefunded = await refundedSoFar(db, item.id)
    const completesLine = addQty(qty(item.returned_qty), line.qty) === qty(item.qty)
    const refund = completesLine
      ? sub(item.line_total as Money, alreadyRefunded)
      : paise(Math.round((item.line_total * line.qty) / item.qty))

    // Splitting tax out of the refund keeps each credit note internally consistent:
    // taxable + cgst + sgst equals the refund exactly, as on the original invoice.
    const tax = splitTax(refund, item.tax_rate_bp, supply)

    computed.push({
      billItemId: item.id,
      productId: item.product_id,
      qty: line.qty,
      baseQty: qty(Math.round((item.base_qty * line.qty) / item.qty)),
      refund,
      taxableValue: tax.taxableValue,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
    })
  }

  const refundTotal = add(...computed.map((l) => l.refund))
  const taxReversed = add(...computed.map((l) => add(l.cgst, l.sgst, l.igst)))
  const returnId = newId()
  const nowIso = now.toISOString()
  const postingDate = businessDate(now)

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO sales_returns
         (id, doc_no, docstatus, bill_id, posting_date, refund_total, tax_reversed, refund_method, reason,
          created_by, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnId, `DRAFT-${returnId}`, input.billId, postingDate,
        refundTotal, taxReversed, input.refundMethod, input.reason ?? null,
        input.actorId, nowIso, nowIso,
      ],
    )

    for (const line of computed) {
      await tx.execute(
        `INSERT INTO sales_return_items
           (id, return_id, bill_item_id, product_id, qty, base_qty, refund_amount,
            taxable_value, cgst_amount, sgst_amount, igst_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(), returnId, line.billItemId, line.productId, line.qty, line.baseQty,
          line.refund, line.taxableValue, line.cgst, line.sgst, line.igst,
        ],
      )
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: returnId, action: 'create', docstatusTo: DRAFT,
    })
  })

  return { ok: true, returnId, refundTotal, taxReversed, lineCount: computed.length }
}

export async function submitReturn(
  db: SqlDriver,
  input: { returnId: string; actorId: string; now?: Date },
): Promise<SubmitReturnResult> {
  const now = input.now ?? new Date()
  const ret = await loadReturn(db, input.returnId)
  assertCanApply('return', parseDocStatus(ret.docstatus), 'submit')

  const bill = await db.get<{ docstatus: number; register_id: string; customer_id: string | null; grand_total: number; posting_date: string }>(
    `SELECT docstatus, register_id, customer_id, grand_total, posting_date FROM bills WHERE id = ?`,
    [ret.billId],
  )
  if (!bill || bill.docstatus !== SUBMITTED) return { ok: false, code: 'BILL_CANCELLED' }

  const lines = await db.query<{ bill_item_id: string; product_id: string; qty: number; base_qty: number }>(
    `SELECT bill_item_id, product_id, qty, base_qty FROM sales_return_items WHERE return_id = ?`,
    [input.returnId],
  )

  const register = await db.get<{ prefix: string }>(`SELECT prefix FROM registers WHERE id = ?`, [bill.register_id])
  const nowIso = now.toISOString()
  let docNo = ''
  let pointsClawedBack = 0

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'return', register?.prefix ?? 'XX', now)

    for (const line of lines) {
      await postMovement(tx, {
        productId: line.product_id,
        qtyChange: qty(line.base_qty),
        unitCost: await issuedUnitCost(tx, 'bill', ret.billId, line.product_id),
        voucherType: 'sales_return',
        voucherId: input.returnId,
        postingDate: ret.postingDate,
        userId: input.actorId,
      })
      await tx.execute(
        `UPDATE bill_items SET returned_qty = returned_qty + ? WHERE id = ?`,
        [line.qty, line.bill_item_id],
      )
    }

    // The refund comes out of whichever drawer is open now — a return days later
    // must not reach back into a session that has already been counted and closed.
    if (ret.refundMethod !== 'credit') {
      const session = await openSessionFor(tx, bill.register_id)
      if (session) {
        await postCashMovement(tx, {
          sessionId: session,
          direction: 'out',
          amount: ret.refundTotal,
          method: ret.refundMethod,
          sourceType: 'sales_return',
          sourceId: input.returnId,
          userId: input.actorId,
          now,
        })
      }
    }

    if (bill.customer_id && bill.grand_total > 0) {
      pointsClawedBack = await clawBackPoints(tx, ret.billId, ret.refundTotal, bill.grand_total as Money)
    }

    await tx.execute(
      `UPDATE sales_returns SET docstatus = 1, doc_no = ?, updated_at = ? WHERE id = ?`,
      [docNo, nowIso, input.returnId],
    )

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: input.returnId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      before: { doc_no: ret.docNo }, after: { doc_no: docNo },
    })
  })

  return { ok: true, returnId: input.returnId, docNo, refundTotal: ret.refundTotal, pointsClawedBack }
}

export async function cancelReturn(
  db: SqlDriver,
  input: { returnId: string; reason?: string; actorId: string; now?: Date },
): Promise<{ ok: true; returnId: string }> {
  const now = input.now ?? new Date()
  const ret = await loadReturn(db, input.returnId)
  assertCanApply('return', parseDocStatus(ret.docstatus), 'cancel')

  const lines = await db.query<{ bill_item_id: string; qty: number }>(
    `SELECT bill_item_id, qty FROM sales_return_items WHERE return_id = ?`,
    [input.returnId],
  )
  const nowIso = now.toISOString()

  await db.transaction(async (tx) => {
    await reverseVoucher(tx, 'sales_return', input.returnId, ret.postingDate, input.actorId)

    for (const line of lines) {
      await tx.execute(`UPDATE bill_items SET returned_qty = returned_qty - ? WHERE id = ?`, [line.qty, line.bill_item_id])
    }

    await tx.execute(
      `UPDATE sales_returns SET docstatus = 2, updated_at = ? WHERE id = ?`,
      [nowIso, input.returnId],
    )

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: input.returnId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, returnId: input.returnId }
}

/**
 * Points are clawed back in proportion to what was refunded, but never below what
 * the customer has already spent — those points are gone, and a negative balance
 * would be worse than absorbing the difference.
 */
async function clawBackPoints(tx: SqlDriver, billId: string, refund: Money, billTotal: Money): Promise<number> {
  const entry = await tx.get<{ id: string; points: number; consumed: number }>(
    `SELECT id, points, consumed FROM loyalty_entries WHERE bill_id = ? AND cancelled_at IS NULL`,
    [billId],
  )
  if (!entry) return 0

  const proportional = Math.round((entry.points * refund) / billTotal)
  const removable = Math.max(0, Math.min(proportional, entry.points - entry.consumed))
  if (removable === 0) return 0

  await tx.execute(`UPDATE loyalty_entries SET points = points - ? WHERE id = ?`, [removable, entry.id])
  return removable
}

async function refundedSoFar(db: SqlDriver, billItemId: string): Promise<Money> {
  const row = await db.get<{ total: number | null }>(
    `SELECT SUM(sri.refund_amount) AS total
       FROM sales_return_items sri
       JOIN sales_returns sr ON sr.id = sri.return_id AND sr.docstatus = 1
      WHERE sri.bill_item_id = ?`,
    [billItemId],
  )
  return (row?.total ?? 0) as Money
}

interface ReturnRow {
  id: string
  docNo: string
  docstatus: number
  billId: string
  postingDate: string
  refundTotal: Money
  refundMethod: RefundMethod
}

async function loadReturn(db: SqlDriver, returnId: string): Promise<ReturnRow> {
  const row = await db.get<{
    id: string; doc_no: string; docstatus: number; bill_id: string
    posting_date: string; refund_total: number; refund_method: string
  }>(
    `SELECT id, doc_no, docstatus, bill_id, posting_date, refund_total, refund_method
       FROM sales_returns WHERE id = ?`,
    [returnId],
  )
  if (!row) throw new Error(`unknown return: ${returnId}`)
  return {
    id: row.id,
    docNo: row.doc_no,
    docstatus: row.docstatus,
    billId: row.bill_id,
    postingDate: row.posting_date,
    refundTotal: row.refund_total as Money,
    refundMethod: row.refund_method as RefundMethod,
  }
}

export async function returnableQty(db: SqlDriver, billItemId: string): Promise<Qty> {
  const row = await db.get<{ qty: number; returned_qty: number }>(
    `SELECT qty, returned_qty FROM bill_items WHERE id = ?`,
    [billItemId],
  )
  if (!row) return qty(0)
  return subQty(qty(row.qty), qty(row.returned_qty))
}

export const ZERO_REFUND = ZERO
