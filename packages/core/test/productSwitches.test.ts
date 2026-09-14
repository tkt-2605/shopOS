import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { createReturn } from '../src/services/returns.js'
import { setStockPolicy } from '../src/services/features.js'
import { searchProducts } from '../src/repos/catalog.js'
import { reorderList } from '../src/repos/reorder.js'
import { fromUnits } from '../src/quantity.js'
import { rupees } from '../src/money.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Two switches on a product that the code has always read and no screen ever
 * wrote — so `return_blocked` was a refusal that could not fire and
 * `is_stock_tracked` was a question with one answer.
 *
 * The product form writes both now. These are the tests that say the switches
 * do something, because a switch that is on and does nothing is the worst
 * failure this product has.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function sell(productId: string, units = 1) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(`draft refused: ${draft.code}`)

  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  return { billId: draft.billId, done }
}

describe('an item that cannot be returned', () => {
  it('is refused at the return, by name', async () => {
    const p = await makeProduct(fx.db, { name: 'Mobile recharge ₹199', baseRate: rupees(199) })
    await fx.db.execute(`UPDATE products SET return_blocked = 1 WHERE id = ?`, [p])

    const { billId } = await sell(p)
    const item = await fx.db.get<{ id: string }>(
      `SELECT id FROM bill_items WHERE bill_id = ?`, [billId],
    )

    const refund = await createReturn(fx.db, {
      billId,
      lines: [{ billItemId: item!.id, qty: fromUnits(1) }],
      refundMethod: 'cash',
      actorId: fx.adminId,
    })
    expect(refund.ok).toBe(false)
    if (!refund.ok) {
      expect(refund.code).toBe('RETURN_BLOCKED')
      // Named, because a cashier holding the item needs to know which line it is.
      if (refund.code === 'RETURN_BLOCKED') expect(refund.productName).toBe('Mobile recharge ₹199')
    }
  })

  it('is returnable when the shop has not blocked it', async () => {
    const p = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(40) })
    const { billId } = await sell(p)
    const item = await fx.db.get<{ id: string }>(
      `SELECT id FROM bill_items WHERE bill_id = ?`, [billId],
    )

    const refund = await createReturn(fx.db, {
      billId,
      lines: [{ billItemId: item!.id, qty: fromUnits(1) }],
      refundMethod: 'cash',
      actorId: fx.adminId,
    })
    expect(refund.ok).toBe(true)
  })

  it('is on the list the product form reads back, so the box is not always blank', async () => {
    const p = await makeProduct(fx.db, { name: 'Recharge' })
    await fx.db.execute(`UPDATE products SET return_blocked = 1 WHERE id = ?`, [p])

    const found = (await searchProducts(fx.db, { term: 'Recharge' })).find((r) => r.id === p)
    expect(found?.returnBlocked).toBe(true)
  })
})

describe('an item with no shelf to run out of', () => {
  it('can be sold by a shop that otherwise refuses to sell below the count', async () => {
    await setStockPolicy(fx.db, { actorId: fx.adminId }, 'block')

    const service = await makeProduct(fx.db, { name: 'Delivery charge', baseRate: rupees(50) })
    await fx.db.execute(`UPDATE products SET is_stock_tracked = 0 WHERE id = ?`, [service])

    // Nothing was ever received into stock, and it sells anyway — twice.
    expect((await sell(service)).done.ok).toBe(true)
    expect((await sell(service)).done.ok).toBe(true)
  })

  it('is still refused when the shop does count it', async () => {
    await setStockPolicy(fx.db, { actorId: fx.adminId }, 'block')

    const shelved = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(40) })
    const { done } = await sell(shelved)
    expect(done.ok).toBe(false)
    if (!done.ok) expect(done.code).toBe('INSUFFICIENT_STOCK')
  })

  it('never appears on a list of things to buy more of', async () => {
    const service = await makeProduct(fx.db, { name: 'Repair fee', baseRate: rupees(150) })
    await fx.db.execute(
      `UPDATE products SET is_stock_tracked = 0, reorder_level = ? WHERE id = ?`,
      [fromUnits(10), service],
    )

    const rows = await reorderList(fx.db)
    expect(rows.some((r) => r.productId === service)).toBe(false)
  })
})
