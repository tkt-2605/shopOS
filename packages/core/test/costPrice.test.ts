import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { saveProductDetails } from '../src/services/products.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { createDocument, submitDocument, loadDocument } from '../src/services/documents.js'
import { receivePurchaseOrder } from '../src/services/convert.js'
import { costHint, costHints } from '../src/repos/costs.js'
import { searchProducts } from '../src/repos/catalog.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, type Qty } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * The cost price typed on an item (074), and the last price paid, offered to
 * whoever types a cost next -- and kept out of everything that values stock.
 */

let fx: Fixture
let productId: string
let supplierId: string

beforeEach(async () => {
  fx = await freshDb()
  productId = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 1800 })
  supplierId = newId()
  const now = new Date().toISOString()
  await fx.db.execute(
    'INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [supplierId, 'Paper Mills', now, now],
  )
})

afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

async function details(costPrice: Money | null | undefined, at?: string) {
  return saveProductDetails(fx.db, { ...ctx(), ...(at ? { now: () => at } : {}) }, {
    id: productId, name: 'Test Product', brand: null, hsnCode: null, taxRateBp: 1800,
    baseRate: rupees(100), mrp: null, baseUnit: 'piece', discountBlocked: false,
    loyaltyBlocked: false, returnBlocked: false, isStockTracked: true,
    reorderLevel: null, reorderQty: null,
    ...(costPrice === undefined ? {} : { costPrice }),
  })
}

async function receive(entryType: 'purchase' | 'opening' | 'adjustment', unitCost: Money, units = 10, postingDate?: string) {
  const entry = await createStockEntry(fx.db, {
    entryType,
    supplierId: entryType === 'purchase' ? supplierId : null,
    supplierName: entryType === 'purchase' ? 'Paper Mills' : null,
    reference: '',
    lines: [{ productId, qty: fromUnits(units), unitCost }],
    ...(postingDate ? { postingDate } : {}),
    actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error(`refused: ${entry.code}`)
  const done = await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(`not submitted: ${done.code}`)
}

describe('the cost price on an item', () => {
  it('is saved, read back with the item, and put on the audit trail', async () => {
    expect(await details(rupees(62))).toMatchObject({ ok: true })
    const [row] = await searchProducts(fx.db, { term: 'Test Product' })
    expect(row?.costPrice).toBe(rupees(62))

    const audit = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity = 'products' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`,
      [productId],
    )
    expect(audit!.diff).toContain('cost_price')
    expect(audit!.diff).toContain(String(rupees(62)))
  })

  it('is left alone by a caller that does not send it, and cleared by one that sends null', async () => {
    await details(rupees(62))
    await details(undefined)
    expect((await searchProducts(fx.db, { term: 'Test Product' }))[0]?.costPrice).toBe(rupees(62))
    await details(null)
    expect((await searchProducts(fx.db, { term: 'Test Product' }))[0]?.costPrice).toBeNull()
  })

  it('refuses a cost below zero', async () => {
    expect(await details(-1 as Money)).toEqual({ ok: false, code: 'BAD_COST' })
  })

  it('values nothing: stock received with no cost is not valued at it', async () => {
    // The rule the column must not cross. Valuation reads movements, and a
    // receipt with no cost at all on an item never bought stays at zero.
    await details(rupees(62))
    await receive('adjustment', 0 as Money, 5)
    const row = await fx.db.get<{ unit_cost: number | null }>(
      'SELECT unit_cost FROM stock_ledger WHERE product_id = ? ORDER BY rowid DESC LIMIT 1', [productId],
    )
    expect(row?.unit_cost).not.toBe(rupees(62))
  })
})

describe('the cost offered to the person typing one', () => {
  it('is the cost price while the item has never been bought in', async () => {
    await details(rupees(62))
    expect(await costHint(fx.db, productId)).toMatchObject({ unitCost: rupees(62), source: 'item', postedOn: null })
  })

  it('is nothing at all for an item with neither', async () => {
    expect(await costHint(fx.db, productId)).toBeNull()
  })

  it('is the last price paid once there is one, over the cost price', async () => {
    await details(rupees(62))
    await receive('purchase', rupees(58), 10, '2026-10-01')
    await receive('purchase', rupees(61), 10, '2026-10-15')
    expect(await costHint(fx.db, productId)).toMatchObject({
      unitCost: rupees(61), source: 'purchase', postedOn: '2026-10-15', supplierName: 'Paper Mills',
    })
  })

  it('is the cost price once it is typed after the last delivery', async () => {
    // The owner has heard the price has moved and says so before the next bill.
    await receive('purchase', rupees(58))
    await details(rupees(50), new Date(Date.now() + 60_000).toISOString())
    expect(await costHint(fx.db, productId)).toMatchObject({ unitCost: rupees(50), source: 'item' })
  })

  it('goes back to the price paid when a delivery comes in after the cost price', async () => {
    await details(rupees(50), new Date(Date.now() - 60_000).toISOString())
    await receive('purchase', rupees(58))
    expect(await costHint(fx.db, productId)).toMatchObject({ unitCost: rupees(58), source: 'purchase' })
  })

  it('stamps the cost price only when it moves, so saving the item again does not make it newer', async () => {
    await details(rupees(50), '2026-10-01T00:00:00.000Z')
    await details(rupees(50), '2026-10-20T00:00:00.000Z')
    const row = await fx.db.get<{ cost_price_at: string }>('SELECT cost_price_at FROM products WHERE id = ?', [productId])
    expect(row?.cost_price_at).toBe('2026-10-01T00:00:00.000Z')
    await details(null, '2026-10-21T00:00:00.000Z')
    expect((await fx.db.get<{ cost_price_at: string | null }>(
      'SELECT cost_price_at FROM products WHERE id = ?', [productId]))?.cost_price_at).toBeNull()
  })

  it('treats a cost price of unknown age as older than any price paid', async () => {
    await receive('purchase', rupees(58))
    // As a row arrives from a till below 075: the cost, and no time for it.
    await fx.db.execute('UPDATE products SET cost_price = ?, cost_price_at = NULL WHERE id = ?', [rupees(50), productId])
    expect(await costHint(fx.db, productId)).toMatchObject({ unitCost: rupees(58), source: 'purchase' })
  })

  it('counts opening stock as bought, and passes over an adjustment and a zero', async () => {
    await receive('opening', rupees(55), 10, '2026-10-01')
    await receive('adjustment', rupees(99), 1, '2026-10-02')
    await receive('purchase', 0 as Money, 1, '2026-10-03')
    expect(await costHint(fx.db, productId)).toMatchObject({ unitCost: rupees(55), source: 'opening' })
  })

  it('answers for several items at once and leaves out the ones it knows nothing of', async () => {
    const other = await makeProduct(fx.db, { name: 'Other' })
    await details(rupees(62))
    const hints = await costHints(fx.db, [productId, other, productId])
    expect([...hints.keys()]).toEqual([productId])
  })
})

describe('a purchase order', () => {
  async function order(line: { rateOverride?: Money; rateIncludesTax?: boolean }, units = 10) {
    const made = await createDocument(fx.db, {
      kind: 'purchase_order', registerId: fx.seed.registerId, supplierId,
      lines: [{ productId, qty: fromUnits(units) as Qty, ...line }],
      actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(`refused: ${made.code}`)
    return made
  }

  it('fills a blank rate with the last price paid, before tax -- never the selling price', async () => {
    await receive('purchase', rupees(58))
    const made = await order({})
    const doc = await loadDocument(fx.db, made.documentId)
    expect(doc!.items[0]).toMatchObject({ rate: rupees(58), rateIncludesTax: false })
  })

  it('fills a blank rate with the cost price for an item never bought, and zero with neither', async () => {
    await details(rupees(62))
    expect((await loadDocument(fx.db, (await order({})).documentId))!.items[0]!.rate).toBe(rupees(62))
    await details(null)
    expect((await loadDocument(fx.db, (await order({})).documentId))!.items[0]!.rate).toBe(0)
  })

  it('receives a rate typed with GST at the price before it', async () => {
    // ₹118 with 18% in it is ₹100 of goods and ₹18 of the supplier's tax.
    const made = await order({ rateOverride: rupees(118), rateIncludesTax: true })
    await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
    await receivePurchaseOrder(fx.db, { purchaseOrderId: made.documentId, actorId: fx.adminId })
    const row = await fx.db.get<{ unit_cost: number }>(
      `SELECT sei.unit_cost FROM stock_entry_items sei JOIN stock_entries se ON se.id = sei.entry_id
        WHERE se.reference = ? AND sei.product_id = ?`,
      [(await loadDocument(fx.db, made.documentId))!.docNo, productId],
    )
    expect(row?.unit_cost).toBe(rupees(100))
  })

  it('receives a rate typed before GST exactly as typed, as it always has', async () => {
    const made = await order({ rateOverride: rupees(60) })
    await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
    await receivePurchaseOrder(fx.db, { purchaseOrderId: made.documentId, actorId: fx.adminId })
    expect(await costHint(fx.db, productId)).toMatchObject({ unitCost: rupees(60), source: 'purchase' })
  })
})
