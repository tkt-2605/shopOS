import { eq, and } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import { add } from '../../money.js'
import type { ComputedTotals } from '../../domain/billTotals.js'
import { DRAFT } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { type ComputedLine, priceBill } from './price.js'
import type { CreateBillInput, CreateBillResult } from './types.js'
import { requirePermission } from '../../integrity/permissions.js'

/*
 * A bill before it is final: created, and saved again as the cashier works.
 */

/**
 * Writes the line rows against figures already computed. `bill_items.discount`
 * holds the line's own discount plus its share of the bill-level one, and
 * `line_total` is already net, so the rows reconcile to the invoice total exactly.
 */
async function writeLines(
  tx: SqlDriver,
  billId: string,
  computed: ComputedLine[],
  totals: ComputedTotals,
): Promise<void> {
  for (const [i, line] of computed.entries()) {
    const t = totals.lines[i]!

    await q(tx).insert(schema.billItems).values({
      id: newId(),
      billId,
      idx: i + 1,
      productId: line.productId,
      productName: line.productName,
      hsnCode: line.hsnCode,
      saleUnit: line.saleUnit,
      qty: line.qty,
      baseQty: line.baseQty,
      rate: line.rate,
      mrp: line.mrp,
      discount: add(line.discount, t.billDiscountShare),
      lineTotal: t.net,
      taxableValue: t.tax.taxableValue,
      taxRateBp: line.taxRateBp,
      cgstAmount: t.tax.cgst,
      sgstAmount: t.tax.sgst,
      igstAmount: t.tax.igst,
      cessRateBp: line.cessRateBp,
      cessAmount: t.tax.cess,
      rateIncludesTax: line.rateIncludesTax ? 1 : 0,
      priceSource: line.priceSource,
      priceSourceId: line.priceSourceId,
      batchId: line.batchId,
      discountBlocked: line.discountBlocked ? 1 : 0,
      loyaltyBlocked: line.loyaltyBlocked ? 1 : 0,
    })
  }
}

export async function createBill(db: SqlDriver, input: CreateBillInput): Promise<CreateBillResult> {
  await requirePermission(db, input.actorId, 'bill', 'create')
  const priced = await priceBill(db, input)
  if (!priced.ok) return priced

  const { computed, totals, meta, subtotal } = priced
  const billId = newId()
  const nowIso = meta.now.toISOString()

  await db.transaction(async (tx) => {
    /* The row goes in with its money at zero and is filled in below, after the
       lines have been written. That order is older than this rewrite and worth
       keeping: the lines are what the totals are *of*, and a bill row carrying
       a grand total with nothing under it is a state no reader should ever be
       able to see, even inside a transaction. */
    await q(tx).insert(schema.bills).values({
      id: billId,
      docNo: `DRAFT-${billId}`,
      docstatus: DRAFT,
      registerId: input.registerId,
      sessionId: meta.sessionId,
      customerId: meta.customerId,
      customerName: meta.customerName,
      postingDate: meta.postingDate,
      discount: totals.discount,
      placeOfSupply: meta.placeOfSupply,
      notes: meta.notes,
      convertedFrom: input.convertedFrom ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    await writeLines(tx, billId, computed, totals)

    await q(tx).update(schema.bills)
      .set({
        subtotal,
        taxableTotal: totals.taxableTotal,
        taxTotal: totals.taxTotal,
        roundOff: totals.roundOff,
        grandTotal: totals.grandTotal,
      })
      .where(eq(schema.bills.id, billId))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: billId, action: 'create', docstatusTo: DRAFT,
    })
  })

  return {
    ok: true,
    billId,
    docNo: `DRAFT-${billId}`,
    lineCount: computed.length,
    subtotal,
    discount: totals.discount,
    taxableTotal: totals.taxableTotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
  }
}

export type SaveDraftResult = CreateBillResult | { ok: false; code: 'NOT_A_DRAFT' }

/**
 * Replaces a draft's contents in place. The counter calls this as the cashier works,
 * so an interrupted bill survives switching screens, a crash, or the power going out —
 * and so a bill can be held while somebody else is served.
 *
 * Lines are rewritten wholesale rather than diffed: a draft has no ledger effect, so
 * there is nothing a diff would protect and a great deal it could get wrong.
 */
export async function saveDraft(
  db: SqlDriver,
  input: CreateBillInput & { billId: string },
): Promise<SaveDraftResult> {
  await requirePermission(db, input.actorId, 'bill', 'create')
  const [existing] = await q(db)
    .select({ docstatus: schema.bills.docstatus })
    .from(schema.bills)
    .where(eq(schema.bills.id, input.billId))
  if (!existing || existing.docstatus !== DRAFT) return { ok: false, code: 'NOT_A_DRAFT' }

  const priced = await priceBill(db, input, input.billId)
  if (!priced.ok) return priced

  const { computed, totals, meta, subtotal } = priced

  await db.transaction(async (tx) => {
    await q(tx).delete(schema.billItems).where(eq(schema.billItems.billId, input.billId))
    await writeLines(tx, input.billId, computed, totals)

    await q(tx).update(schema.bills)
      .set({
        sessionId: meta.sessionId,
        customerId: meta.customerId,
        customerName: meta.customerName,
        postingDate: meta.postingDate,
        subtotal,
        discount: totals.discount,
        taxableTotal: totals.taxableTotal,
        taxTotal: totals.taxTotal,
        roundOff: totals.roundOff,
        grandTotal: totals.grandTotal,
        // Written plainly rather than kept: a cart cleared of the order's items
        // and refilled with others is no longer that order's bill, and the
        // counter is what knows which it is.
        placeOfSupply: meta.placeOfSupply,
        notes: meta.notes,
        convertedFrom: input.convertedFrom ?? null,
        updatedAt: meta.now.toISOString(),
      })
      /* The docstatus is in the WHERE and not merely checked above. The read
         that let this call through happened before the transaction opened, and
         a draft submitted by the other till in between must not be rewritten. */
      .where(and(eq(schema.bills.id, input.billId), eq(schema.bills.docstatus, DRAFT)))
  })

  return {
    ok: true,
    billId: input.billId,
    docNo: `DRAFT-${input.billId}`,
    lineCount: computed.length,
    subtotal,
    discount: totals.discount,
    taxableTotal: totals.taxableTotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
  }
}
