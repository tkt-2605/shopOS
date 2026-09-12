import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'
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
  const rows = await db.query<{
    id: string; customer_name: string | null; grand_total: number
    updated_at: string; line_count: number; preview: string | null
  }>(
    `SELECT b.id, b.customer_name, b.grand_total, b.updated_at,
            (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id) AS line_count,
            (SELECT GROUP_CONCAT(i.product_name, ', ')
               FROM (SELECT product_name FROM bill_items WHERE bill_id = b.id ORDER BY idx LIMIT 3) i
            ) AS preview
       FROM bills b
      WHERE b.docstatus = ? AND b.register_id = ?
      ORDER BY b.created_at`,
    [DRAFT, registerId],
  )

  return rows
    .filter((r) => r.line_count > 0)
    .map((r) => ({
      billId: r.id,
      customerName: r.customer_name,
      lineCount: r.line_count,
      grandTotal: r.grand_total as Money,
      updatedAt: r.updated_at,
      preview: r.preview ?? '',
    }))
}

export interface DraftLine {
  productId: string
  productName: string
  saleUnit: string
  qty: Qty
  rate: Money
  discount: Money
  priceSource: string
}

export interface DraftDetail {
  billId: string
  customerId: string | null
  customerName: string | null
  billDiscount: Money
  lines: DraftLine[]
}

export async function loadDraft(db: SqlDriver, billId: string): Promise<DraftDetail | null> {
  const bill = await db.get<{
    id: string; docstatus: number; customer_id: string | null; customer_name: string | null; discount: number
  }>(
    `SELECT id, docstatus, customer_id, customer_name, discount FROM bills WHERE id = ?`,
    [billId],
  )
  if (!bill || bill.docstatus !== DRAFT) return null

  const lines = await db.query<{
    product_id: string; product_name: string; sale_unit: string
    qty: number; rate: number; discount: number; price_source: string
  }>(
    `SELECT product_id, product_name, sale_unit, qty, rate, discount, price_source
       FROM bill_items WHERE bill_id = ? ORDER BY idx`,
    [billId],
  )

  return {
    billId: bill.id,
    customerId: bill.customer_id,
    customerName: bill.customer_name,
    billDiscount: bill.discount as Money,
    lines: lines.map((l) => ({
      productId: l.product_id,
      productName: l.product_name,
      saleUnit: l.sale_unit,
      qty: l.qty as Qty,
      rate: l.rate as Money,
      discount: l.discount as Money,
      priceSource: l.price_source,
    })),
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
  const bill = await db.get<{ docstatus: number }>(`SELECT docstatus FROM bills WHERE id = ?`, [input.billId])
  if (!bill) return { ok: true }
  if (bill.docstatus !== DRAFT) return { ok: false, code: 'NOT_A_DRAFT' }

  await db.transaction(async (tx) => {
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: input.billId, action: 'delete', docstatusFrom: DRAFT,
    })
    await tx.execute(`DELETE FROM bill_items WHERE bill_id = ?`, [input.billId])
    await tx.execute(`DELETE FROM bills WHERE id = ? AND docstatus = ?`, [input.billId, DRAFT])
  })

  return { ok: true }
}

/**
 * Clears drafts nothing was ever added to. The counter creates one the moment a
 * bill is started, so abandoning a scan before the first item would otherwise
 * leave a trail of empty rows behind.
 */
export async function pruneEmptyDrafts(db: SqlDriver, registerId: string): Promise<number> {
  const result = await db.execute(
    `DELETE FROM bills
      WHERE docstatus = ? AND register_id = ?
        AND NOT EXISTS (SELECT 1 FROM bill_items i WHERE i.bill_id = bills.id)`,
    [DRAFT, registerId],
  )
  return result.rowsAffected
}
