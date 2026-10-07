import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PermissionError } from '../src/integrity/permissions.js'
import { createUser } from '../src/services/auth.js'
import { createBill, submitBill, saveDraft } from '../src/services/billing.js'
import { saveProductDetails } from '../src/services/products.js'
import { searchProducts } from '../src/repos/catalog/products.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * The loose item: priced at the counter every time it is sold (068).
 *
 * A shop's old billing machine had one item that asked for an amount and kept
 * no stock, so a handful of clips or a bundle of oddments could be billed
 * without cataloguing them. Here typing a rate is a price decision a cashier
 * does not have; this is the one item where typing it is simply the sale.
 */

let fx: Fixture
let loose: string
let pen: string
beforeEach(async () => {
  fx = await freshDb()
  loose = await makeProduct(fx.db, { name: 'Loose item', baseRate: 0, taxRateBp: 0 })
  await fx.db.execute('UPDATE products SET open_price = 1, is_stock_tracked = 0 WHERE id = ?', [loose])
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
})
afterEach(async () => { await fx.db.close() })

async function cashier(): Promise<string> {
  const made = await createUser(fx.db, {
    username: 'cashier', password: 'counter-9', roleId: fx.seed.roleIds['Cashier']!, actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(made.code)
  return made.userId
}

describe('a loose item', () => {
  it('is billed at the amount typed, by a cashier who cannot set prices', async () => {
    const actorId = await cashier()
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: loose, qty: fromUnits(1), rateOverride: rupees(37) as Money }],
      actorId,
    })
    if (!draft.ok) throw new Error(draft.code)
    expect(draft.grandTotal).toBe(rupees(37))

    const paid = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId,
    })
    expect(paid.ok).toBe(true)
  })

  it('does not let that cashier type a price on anything else on the same bill', async () => {
    const actorId = await cashier()
    await expect(createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [
        { productId: loose, qty: fromUnits(1), rateOverride: rupees(37) as Money },
        { productId: pen, qty: fromUnits(1), rateOverride: rupees(1) as Money },
      ],
      actorId,
    })).rejects.toBeInstanceOf(PermissionError)
  })

  it('is refused at nothing, typed or forgotten', async () => {
    /* A forgotten amount going through is a free sale nobody meant. */
    for (const line of [
      { productId: loose, qty: fromUnits(1) },
      { productId: loose, qty: fromUnits(1), rateOverride: 0 as Money },
    ]) {
      const draft = await createBill(fx.db, { registerId: fx.seed.registerId, lines: [line], actorId: fx.adminId })
      expect(draft).toMatchObject({ ok: false, code: 'OPEN_PRICE_NEEDS_AMOUNT', productName: 'Loose item' })
    }
  })

  it('keeps its amount when a held bill is saved again', async () => {
    const actorId = await cashier()
    const line = { productId: loose, qty: fromUnits(1), rateOverride: rupees(37) as Money }
    const draft = await createBill(fx.db, { registerId: fx.seed.registerId, lines: [line], actorId })
    if (!draft.ok) throw new Error(draft.code)
    const again = await saveDraft(fx.db, {
      billId: draft.billId, registerId: fx.seed.registerId, actorId,
      lines: [line, { ...line, rateOverride: rupees(12) as Money }],
    })
    expect(again).toMatchObject({ ok: true, grandTotal: rupees(49) })
  })

  it('leaves an ordinary item at nothing alone, as before', async () => {
    const free = await makeProduct(fx.db, { name: 'Sample', baseRate: 0, taxRateBp: 0 })
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: free, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    expect(draft.ok).toBe(true)
  })
})

describe('setting it on an item', () => {
  it('is saved, read back, and put on the history', async () => {
    const saved = await saveProductDetails(fx.db, { actorId: fx.adminId }, {
      id: pen, name: 'Pen', brand: null, hsnCode: null, taxRateBp: 0, baseRate: rupees(10), mrp: null,
      baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false,
      isStockTracked: true, openPrice: true, reorderLevel: null, reorderQty: null,
    })
    expect(saved.ok).toBe(true)

    const [found] = await searchProducts(fx.db, { term: 'Pen' })
    expect(found?.openPrice).toBe(true)

    const audit = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity = 'products' AND entity_id = ? ORDER BY rowid DESC`, [pen])
    expect(audit?.diff).toContain('open_price')
  })

  it('is left as it was by a caller that does not say', async () => {
    await saveProductDetails(fx.db, { actorId: fx.adminId }, {
      id: loose, name: 'Loose item', brand: null, hsnCode: null, taxRateBp: 0, baseRate: 0 as Money, mrp: null,
      baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false,
      isStockTracked: false, reorderLevel: null, reorderQty: null,
    })
    const [found] = await searchProducts(fx.db, { term: 'Loose' })
    expect(found?.openPrice).toBe(true)
  })
})
