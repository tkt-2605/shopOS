import type { SqlDriver } from '../db/driver.js'
import { businessDate } from '../dates.js'
import { newId } from '../ids.js'
import { type Money, ZERO, paise, add, sub } from '../money.js'
import { type Qty, qty, addQty, subQty } from '../quantity.js'
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

  const bill = await db.get<{ id: string; docstatus: number; place_of_supply: string | null }>(
    `SELECT id, docstatus, place_of_supply FROM bills WHERE id = ?`,
    [billId],
  )
  if (!bill) throw new Error(`unknown bill: ${billId}`)
  if (bill.docstatus !== SUBMITTED) return { ok: false, code: 'BILL_NOT_SUBMITTED' }

  const shopState = await getSetting(db, 'shop_state_code')
  const supply = supplyTypeFor(shopState, bill.place_of_supply)

  const computed: ComputedReturnLine[] = []

  for (const line of lines) {
    const item = await db.get<{
      id: string; product_id: string; product_name: string; qty: number; base_qty: number
      returned_qty: number; line_total: number; tax_rate_bp: number
    }>(
      `SELECT id, product_id, product_name, qty, base_qty, returned_qty, line_total, tax_rate_bp
         FROM bill_items WHERE id = ? AND bill_id = ?`,
      [line.billItemId, billId],
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
      productName: item.product_name,
      qty: line.qty,
      baseQty: qty(Math.round((item.base_qty * line.qty) / item.qty)),
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
    await tx.execute(
      `INSERT INTO sales_returns
         (id, doc_no, docstatus, bill_id, posting_date, refund_total, tax_reversed, refund_method, reason,
          created_by, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnId, `DRAFT-${returnId}`, input.billId, postingDate,
        computed.refundTotal, computed.taxReversed, input.refundMethod, input.reason ?? null,
        input.actorId, nowIso, nowIso,
      ],
    )

    for (const line of computed.lines) {
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
    await db.execute(`DELETE FROM sales_return_items WHERE return_id = ?`, [created.returnId])
    await db.execute(`DELETE FROM sales_returns WHERE id = ?`, [created.returnId])
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

  const bill = await db.get<{
    docstatus: number; register_id: string; customer_id: string | null
    grand_total: number; posting_date: string; doc_no: string
  }>(
    `SELECT docstatus, register_id, customer_id, grand_total, posting_date, doc_no FROM bills WHERE id = ?`,
    [ret.billId],
  )
  if (!bill || bill.docstatus !== SUBMITTED) return { ok: false, code: 'BILL_CANCELLED' }

  const split = splitRefund(ret.refundTotal, await refundBasis(db, ret.billId))

  // A refund onto the account can only take off what is owed. This product has
  // no store-credit wallet, and inventing one here would leave money sitting
  // somewhere no screen adds up. Cash, or a smaller return.
  if (ret.refundMethod === 'credit' && split.cash > 0) {
    if (!bill.customer_id) return { ok: false, code: 'NOTHING_TO_CREDIT', refund: split.cash, outstanding: ZERO }
    const outstanding = await outstandingFor(db, bill.customer_id)
    if (outstanding < split.cash) {
      return { ok: false, code: 'NOTHING_TO_CREDIT', refund: split.cash, outstanding }
    }
  }

  const lines = await db.query<{ bill_item_id: string; product_id: string; qty: number; base_qty: number }>(
    `SELECT bill_item_id, product_id, qty, base_qty FROM sales_return_items WHERE return_id = ?`,
    [input.returnId],
  )

  const register = await db.get<{ prefix: string }>(`SELECT prefix FROM registers WHERE id = ?`, [bill.register_id])
  const nowIso = now.toISOString()
  let docNo = ''
  let creditNoteDocNo: string | null = null

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

    if (split.cash > 0) {
      if (ret.refundMethod === 'credit') {
        const note = await postCreditNote(tx, {
          customerId: bill.customer_id!,
          amount: split.cash,
          reference: `${docNo} against ${bill.doc_no}`,
          notes: ret.reason,
          ...(register?.prefix ? { registerPrefix: register.prefix } : {}),
          actorId: input.actorId,
          now,
        })
        creditNoteDocNo = note.docNo
        await tx.execute(`UPDATE sales_returns SET credit_note_id = ? WHERE id = ?`, [note.paymentId, input.returnId])
      } else {
        // Out of whichever drawer is open now — a return days later must not
        // reach back into a session that has been counted and closed.
        const session = await openSessionFor(tx, bill.register_id)
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

    await tx.execute(
      `UPDATE sales_returns
          SET docstatus = 1, doc_no = ?, refund_cash = ?, points_restored = ?, points_removed = ?, updated_at = ?
        WHERE id = ?`,
      [docNo, split.cash, split.pointsRestored, split.pointsRemoved, nowIso, input.returnId],
    )

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

    // Everything the return handed back is taken back, in the same currencies.
    if (ret.creditNoteId) {
      await tx.execute(
        `UPDATE payment_entries SET docstatus = 2, updated_at = ? WHERE id = ?`,
        [nowIso, ret.creditNoteId],
      )
      await writeAudit(tx, { actorId: input.actorId }, {
        entity: 'payment_entries', entityId: ret.creditNoteId, action: 'cancel',
        docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
        after: { cancel_reason: `${ret.docNo} cancelled` },
      })
    }
    if (ret.pointsRestored > 0) await unrestorePoints(tx, ret.billId, ret.pointsRestored)
    if (ret.pointsRemoved > 0) await regrantPoints(tx, ret.billId, ret.pointsRemoved)

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
 * What this bill has paid back already, and in what.
 *
 * Cumulative rather than per-return, because that is what makes the last return
 * hand back the exact remainder instead of a rounded share of it.
 */
async function refundBasis(db: SqlDriver, billId: string): Promise<RefundBasis> {
  const bill = await db.get<{ grand_total: number }>(`SELECT grand_total FROM bills WHERE id = ?`, [billId])

  const paidWithPoints = await db.get<{ amount: number | null }>(
    `SELECT SUM(amount) AS amount FROM bill_payments WHERE bill_id = ? AND method = 'loyalty'`,
    [billId],
  )
  const redeemed = await db.get<{ points: number | null }>(
    `SELECT SUM(points) AS points FROM loyalty_redemptions WHERE bill_id = ? AND reversed_at IS NULL`,
    [billId],
  )
  const earned = await db.get<{ points: number; consumed: number }>(
    `SELECT points, consumed FROM loyalty_entries WHERE bill_id = ? AND cancelled_at IS NULL`,
    [billId],
  )
  const priorReturns = await db.get<{ refunded: number | null; as_points: number | null; removed: number | null }>(
    `SELECT SUM(refund_total) AS refunded,
            SUM(refund_total - refund_cash) AS as_points,
            SUM(points_removed) AS removed
       FROM sales_returns WHERE bill_id = ? AND docstatus = 1`,
    [billId],
  )

  return {
    billTotal: (bill?.grand_total ?? 0) as Money,
    pointsValue: (paidWithPoints?.amount ?? 0) as Money,
    pointsRedeemed: redeemed?.points ?? 0,
    pointsEarned: earned?.points ?? 0,
    pointsEarnedSpent: earned?.consumed ?? 0,
    alreadyRefunded: (priorReturns?.refunded ?? 0) as Money,
    alreadyRestoredValue: (priorReturns?.as_points ?? 0) as Money,
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
  const rows = await tx.query<{ id: string; loyalty_entry_id: string; points: number; restored: number }>(
    `SELECT id, loyalty_entry_id, points, restored FROM loyalty_redemptions
      WHERE bill_id = ? AND reversed_at IS NULL ORDER BY created_at`,
    [billId],
  )

  let remaining = points
  for (const row of rows) {
    if (remaining <= 0) break
    const take = Math.min(remaining, row.points - row.restored)
    if (take <= 0) continue
    await tx.execute(`UPDATE loyalty_entries SET consumed = consumed - ? WHERE id = ?`, [take, row.loyalty_entry_id])
    await tx.execute(`UPDATE loyalty_redemptions SET restored = restored + ? WHERE id = ?`, [take, row.id])
    remaining -= take
  }
}

/** The same, backwards, when the return itself is cancelled. */
async function unrestorePoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
  const rows = await tx.query<{ id: string; loyalty_entry_id: string; restored: number }>(
    `SELECT id, loyalty_entry_id, restored FROM loyalty_redemptions
      WHERE bill_id = ? AND reversed_at IS NULL AND restored > 0 ORDER BY created_at DESC`,
    [billId],
  )

  let remaining = points
  for (const row of rows) {
    if (remaining <= 0) break
    const take = Math.min(remaining, row.restored)
    await tx.execute(`UPDATE loyalty_entries SET consumed = consumed + ? WHERE id = ?`, [take, row.loyalty_entry_id])
    await tx.execute(`UPDATE loyalty_redemptions SET restored = restored - ? WHERE id = ?`, [take, row.id])
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
  const entry = await tx.get<{ id: string; points: number; consumed: number }>(
    `SELECT id, points, consumed FROM loyalty_entries WHERE bill_id = ? AND cancelled_at IS NULL`,
    [billId],
  )
  if (!entry) return

  if (points >= entry.points) {
    await tx.execute(`UPDATE loyalty_entries SET cancelled_at = ? WHERE id = ?`, [nowIso, entry.id])
    return
  }
  await tx.execute(`UPDATE loyalty_entries SET points = points - ? WHERE id = ?`, [points, entry.id])
}

async function regrantPoints(tx: SqlDriver, billId: string, points: number): Promise<void> {
  const entry = await tx.get<{ id: string; points: number; cancelled_at: string | null }>(
    `SELECT id, points, cancelled_at FROM loyalty_entries WHERE bill_id = ?`,
    [billId],
  )
  if (!entry) return

  if (entry.cancelled_at !== null && entry.points === points) {
    await tx.execute(`UPDATE loyalty_entries SET cancelled_at = NULL WHERE id = ?`, [entry.id])
    return
  }
  await tx.execute(`UPDATE loyalty_entries SET points = points + ? WHERE id = ?`, [points, entry.id])
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

/** What is still owed on one bill. */
async function outstandingOn(db: SqlDriver, billId: string): Promise<Money> {
  const row = await db.get<{ due: number | null }>(
    `SELECT b.credit_total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                                         JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                                        WHERE pa.bill_id = b.id), 0) AS due
       FROM bills b WHERE b.id = ?`,
    [billId],
  )
  return paise(Math.max(0, row?.due ?? 0))
}

/** What is still owed across every bill of one customer. */
async function outstandingFor(db: SqlDriver, customerId: string): Promise<Money> {
  const row = await db.get<{ due: number | null }>(
    `SELECT SUM(b.credit_total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                                             JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                                            WHERE pa.bill_id = b.id), 0)) AS due
       FROM bills b WHERE b.customer_id = ? AND b.docstatus = 1 AND b.credit_total > 0`,
    [customerId],
  )
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

/** The returns already taken against a bill, for the screen that shows it. */
export async function listReturns(db: SqlDriver, billId: string): Promise<ReturnListItem[]> {
  const rows = await db.query<{
    id: string; doc_no: string; docstatus: number; posting_date: string
    refund_total: number; refund_cash: number; points_restored: number
    refund_method: string; reason: string | null
  }>(
    `SELECT id, doc_no, docstatus, posting_date, refund_total, refund_cash, points_restored,
            refund_method, reason
       FROM sales_returns WHERE bill_id = ? ORDER BY created_at DESC`,
    [billId],
  )
  return rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    docstatus: r.docstatus,
    postingDate: r.posting_date,
    refundTotal: r.refund_total as Money,
    refundCash: r.refund_cash as Money,
    pointsRestored: r.points_restored,
    refundMethod: r.refund_method as RefundMethod,
    reason: r.reason,
  }))
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
  const row = await db.get<{
    id: string; doc_no: string; docstatus: number; bill_id: string
    posting_date: string; refund_total: number; refund_method: string; reason: string | null
    credit_note_id: string | null; points_restored: number; points_removed: number
  }>(
    `SELECT id, doc_no, docstatus, bill_id, posting_date, refund_total, refund_method, reason,
            credit_note_id, points_restored, points_removed
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
    reason: row.reason,
    creditNoteId: row.credit_note_id,
    pointsRestored: row.points_restored,
    pointsRemoved: row.points_removed,
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
