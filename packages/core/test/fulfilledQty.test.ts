import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDocument, submitDocument } from '../src/services/documents.js'
import { quotationToSalesOrder, receivePurchaseOrder } from '../src/services/convert.js'
import { reconcileFulfilledQty } from '../src/services/documents/reconcile.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * What an order line has been fulfilled by is recorded, row by row (054).
 *
 * A quotation turned into an order, and a purchase order received, raised
 * `fulfilled_qty` and left nothing else behind. Two tills converting against
 * one document while apart each raised their own copy, one copy won the
 * merge, and the other's step was gone with nothing to rebuild it from.
 */

let fx: Fixture
let productId: string
let customerId: string
let supplierId: string

beforeEach(async () => {
  fx = await freshDb()
  productId = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  customerId = await makeCustomer(fx.db, 'Sri Vidya School')
  supplierId = newId()
  const now = new Date().toISOString()
  await fx.db.execute('INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [supplierId, 'Paper Mills', now, now])
})
afterEach(async () => { await fx.db.close() })

async function submitted(kind: 'quotation' | 'purchase_order', units: number) {
  const made = await createDocument(fx.db, {
    kind, registerId: fx.seed.registerId,
    ...(kind === 'quotation' ? { customerId } : { supplierId }),
    lines: [{ productId, qty: fromUnits(units), ...(kind === 'purchase_order' ? { rateOverride: rupees(60) } : {}) }],
    actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(made.code)
  await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
  return made.documentId
}

const lineOf = async (documentId: string) => (await fx.db.get<{ id: string; fulfilled_qty: number }>(
  'SELECT id, fulfilled_qty FROM document_items WHERE document_id = ?', [documentId]))!

describe('turning a quotation into an order', () => {
  it('records what each line became, in the same step', async () => {
    const quotation = await submitted('quotation', 10)
    const order = await quotationToSalesOrder(fx.db, { quotationId: quotation, actorId: fx.adminId })
    if (!order.ok) throw new Error(order.code)

    const rows = await fx.db.query<{ qty: number; target_kind: string; target_id: string }>(
      'SELECT qty, target_kind, target_id FROM document_fulfilments WHERE document_id = ?', [quotation])
    expect(rows).toEqual([{ qty: fromUnits(10), target_kind: 'document', target_id: order.documentId }])
    expect((await lineOf(quotation)).fulfilled_qty).toBe(fromUnits(10))
  })

  it('refuses a second conversion of what the first already took', async () => {
    const quotation = await submitted('quotation', 10)
    await quotationToSalesOrder(fx.db, { quotationId: quotation, actorId: fx.adminId })
    expect(await quotationToSalesOrder(fx.db, { quotationId: quotation, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NOTHING_LEFT' })
  })
})

describe('receiving a purchase order', () => {
  it('records the stock entry it became', async () => {
    const po = await submitted('purchase_order', 20)
    const got = await receivePurchaseOrder(fx.db, { purchaseOrderId: po, actorId: fx.adminId })
    if (!got.ok) throw new Error(got.code)
    const rows = await fx.db.query<{ target_kind: string; target_id: string }>(
      'SELECT target_kind, target_id FROM document_fulfilments WHERE document_id = ?', [po])
    expect(rows).toEqual([{ target_kind: 'stock_entry', target_id: got.stockEntryId }])
  })
})

describe('the fulfilled quantity after a merge', () => {
  it('is put back when the merge lost a step', async () => {
    const quotation = await submitted('quotation', 10)
    await quotationToSalesOrder(fx.db, { quotationId: quotation, actorId: fx.adminId })
    // The copy of the quotation that won the merge had not heard of the conversion.
    await fx.db.execute('UPDATE document_items SET fulfilled_qty = 0 WHERE document_id = ?', [quotation])

    const found = await reconcileFulfilledQty(fx.db, { repair: true, documentIds: [quotation] })
    expect(found).toEqual([expect.objectContaining({ stored: 0, derived: fromUnits(10), repairable: true })])
    expect((await lineOf(quotation)).fulfilled_qty).toBe(fromUnits(10))
  })

  it('is never lowered, because a bill or conversion may not have arrived yet', async () => {
    const quotation = await submitted('quotation', 10)
    await fx.db.execute('UPDATE document_items SET fulfilled_qty = ? WHERE document_id = ?', [fromUnits(4), quotation])

    const found = await reconcileFulfilledQty(fx.db, { repair: true })
    expect(found).toEqual([expect.objectContaining({ stored: fromUnits(4), derived: 0, repairable: false })])
    expect((await lineOf(quotation)).fulfilled_qty).toBe(fromUnits(4))
  })
})
