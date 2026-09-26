import { eq, and, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'
import type { PriceSource } from '../domain/pricing.js'
import { DRAFT } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'

/**
 * Bills in progress at a counter.
 *
 * A held bill is not a separate kind of thing — it is a draft, which is what the
 * document model already calls a bill that has not been submitted. That means a
 * held bill has cost nothing extra to make safe: it moves no stock, posts no
 * ledger entry, takes no number from the invoice series, and survives the machine
 * being switched off at the wall.
 */

export interface OpenDraft {
  billId: string
  customerName: string | null
  lineCount: number
  grandTotal: Money
  updatedAt: string
  /** First few item names, for a tab that has to be recognisable at a glance. */
  preview: string
}

export async function listOpenDrafts(db: SqlDriver, registerId: string): Promise<OpenDraft[]> {
  const rows = await q(db)
    .select({
      billId: schema.bills.id,
      customerName: schema.bills.customerName,
      grandTotal: schema.bills.grandTotal,
      updatedAt: schema.bills.updatedAt,
      lineCount: sql<number>`(SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = bills.id)`,
      /* raw: the first three item names, in the order they were rung up.
         `GROUP_CONCAT` over a subquery that is itself ordered and limited --
         the ordering has to happen before the concatenation, which is why it
         is a derived table and not one aggregate. `bills.id` is written out
         because a bare `id` inside it would bind to `bill_items`. */
      preview: sql<string | null>`(SELECT GROUP_CONCAT(i.product_name, ', ') FROM
        (SELECT product_name FROM bill_items WHERE bill_id = bills.id ORDER BY idx LIMIT 3) i)`,
    })
    .from(schema.bills)
    .where(and(eq(schema.bills.docstatus, DRAFT), eq(schema.bills.registerId, registerId)))
    .orderBy(schema.bills.createdAt)

  // An empty draft is a bill somebody started and walked away from, not a tab.
  return rows
    .filter((r) => r.lineCount > 0)
    .map((r) => ({ ...r, preview: r.preview ?? '' }))
}

export interface DraftLine {
  productId: string
  productName: string
  saleUnit: string
  qty: Qty
  rate: Money
  discount: Money
  /** Which rule set this rate, and the row it came from. */
  priceSource: PriceSource
  priceSourceId: string | null
}

export interface DraftDetail {
  billId: string
  customerId: string | null
  customerName: string | null
  billDiscount: Money
  /**
   * The order this draft is fulfilling, if it was loaded from one.
   *
   * Restored with the draft, so a counter that lost power comes back still
   * knowing which order it was billing — otherwise the order would be left open
   * by a bill that was paid for.
   */
  fromOrder: { id: string; docNo: string } | null
  lines: DraftLine[]
}

export async function loadDraft(db: SqlDriver, billId: string): Promise<DraftDetail | null> {
  const [bill] = await q(db)
    .select({
      id: schema.bills.id,
      docstatus: schema.bills.docstatus,
      customerId: schema.bills.customerId,
      customerName: schema.bills.customerName,
      discount: schema.bills.discount,
      convertedFrom: schema.bills.convertedFrom,
      orderNo: schema.documents.docNo,
    })
    .from(schema.bills)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.bills.convertedFrom))
    .where(eq(schema.bills.id, billId))
  if (!bill || bill.docstatus !== DRAFT) return null

  const lines = await q(db)
    .select({
      productId: schema.billItems.productId,
      productName: schema.billItems.productName,
      saleUnit: schema.billItems.saleUnit,
      qty: schema.billItems.qty,
      rate: schema.billItems.rate,
      discount: schema.billItems.discount,
      priceSource: schema.billItems.priceSource,
      priceSourceId: schema.billItems.priceSourceId,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, billId))
    .orderBy(schema.billItems.idx)

  return {
    billId: bill.id,
    customerId: bill.customerId,
    customerName: bill.customerName,
    billDiscount: bill.discount,
    fromOrder: bill.convertedFrom ? { id: bill.convertedFrom, docNo: bill.orderNo ?? '' } : null,
    /* `price_source` is text in the database and this build knows a fixed set
       of words for it. A row written by a later build could hold another, and
       it is passed on rather than refused: the draft is the cashier's own cart,
       and a word this build does not recognise is not worth losing it over. */
    lines: lines.map((l) => ({ ...l, priceSource: l.priceSource as PriceSource })),
  }
}

export type DiscardResult = { ok: true } | { ok: false; code: 'NOT_A_DRAFT' }

/**
 * Throws away a bill that was never rung up. Only a draft can go — anything
 * submitted is cancelled and kept, because it happened.
 */
export async function discardDraft(
  db: SqlDriver,
  input: { billId: string; actorId: string },
): Promise<DiscardResult> {
  const [bill] = await q(db)
    .select({ docstatus: schema.bills.docstatus })
    .from(schema.bills)
    .where(eq(schema.bills.id, input.billId))
  if (!bill) return { ok: true }
  if (bill.docstatus !== DRAFT) return { ok: false, code: 'NOT_A_DRAFT' }

  return db.transaction(async (tx): Promise<DiscardResult> => {
    /* Asked again in here, before anything is deleted. A submit that lands
       between the check above and this transaction would otherwise keep its
       bill -- the delete below is conditional -- and lose every line under it,
       because the lines went first and unconditionally. */
    const [now] = await q(tx)
      .select({ docstatus: schema.bills.docstatus })
      .from(schema.bills)
      .where(eq(schema.bills.id, input.billId))
    if (!now) return { ok: true }
    if (now.docstatus !== DRAFT) return { ok: false, code: 'NOT_A_DRAFT' }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: input.billId, action: 'delete', docstatusFrom: DRAFT,
    })
    await q(tx).delete(schema.billItems).where(eq(schema.billItems.billId, input.billId))
    await q(tx).delete(schema.bills)
      .where(and(eq(schema.bills.id, input.billId), eq(schema.bills.docstatus, DRAFT)))
    return { ok: true }
  })
}

/**
 * Clears drafts nothing was ever added to. The counter creates one the moment a
 * bill is started, so abandoning a scan before the first item would otherwise
 * leave a trail of empty rows behind.
 */
export async function pruneEmptyDrafts(db: SqlDriver, registerId: string): Promise<number> {
  // raw: how many were cleared is the answer, and the proxy the typed queries
  // go over does not carry a row count back.
  const result = await db.execute(
    `DELETE FROM bills
      WHERE docstatus = ? AND register_id = ?
        AND NOT EXISTS (SELECT 1 FROM bill_items i WHERE i.bill_id = bills.id)`,
    [DRAFT, registerId],
  )
  return result.rowsAffected
}
