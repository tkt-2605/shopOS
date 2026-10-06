import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { createReturn, submitReturn, cancelReturn } from '../src/services/returns.js'
import { postMovement } from '../src/services/stock.js'
import { reconcileReturnedQty } from '../src/services/returns/reconcile.js'
import { freshDb, makeProduct, type Fixture, editingSubmitted } from './helpers.js'
import { newId } from '../src/ids.js'

/**
 * What a bill line has had back is a cache of its returns.
 *
 * Two tills taking a partial return of one bill while apart each raise the
 * bill's revision; one copy of the bill wins the merge and the other till's
 * increment to `returned_qty` is lost, while both returns arrive. The figure
 * is read as "how much can still come back", so the loss is an over-return.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function sold(units: number) {
  const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  await fx.db.transaction((tx) => postMovement(tx, {
    productId: p, qtyChange: fromUnits(10), unitCost: rupees(50),
    voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
  }))
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: p, qty: fromUnits(units) }], actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const paid = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
  })
  if (!paid.ok) throw new Error(paid.code)
  const item = await fx.db.get<{ id: string }>('SELECT id FROM bill_items WHERE bill_id = ?', [draft.billId])
  return { billId: draft.billId, itemId: item!.id }
}

async function giveBack(sale: { billId: string; itemId: string }, units: number) {
  const ret = await createReturn(fx.db, {
    billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(units) }],
    refundMethod: 'cash', actorId: fx.adminId,
  })
  if (!ret.ok) throw new Error(ret.code)
  const done = await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
  return ret.returnId
}

const returnedOn = async (itemId: string) => toUnits((await fx.db.get<{ returned_qty: number }>(
  'SELECT returned_qty FROM bill_items WHERE id = ?', [itemId]))!.returned_qty as never)

describe('returned quantity', () => {
  it('counts both of two returns when the merge kept only one increment', async () => {
    const sale = await sold(5)
    await giveBack(sale, 1)
    await giveBack(sale, 2)
    // What the losing side of the merge leaves: both returns here, one increment.
    await fx.db.execute('UPDATE bill_items SET returned_qty = ? WHERE id = ?', [fromUnits(1), sale.itemId])

    const found = await reconcileReturnedQty(fx.db)
    expect(found).toEqual([{ billItemId: sale.itemId, stored: fromUnits(1), derived: fromUnits(3), repairable: true }])

    await reconcileReturnedQty(fx.db, { repair: true })
    expect(await returnedOn(sale.itemId)).toBe(3)
    expect(await reconcileReturnedQty(fx.db)).toEqual([])
  })

  it('does not count a return that was cancelled', async () => {
    const sale = await sold(5)
    const first = await giveBack(sale, 2)
    await cancelReturn(fx.db, { returnId: first, actorId: fx.adminId })

    expect(await returnedOn(sale.itemId)).toBe(0)
    expect(await reconcileReturnedQty(fx.db)).toEqual([])
  })

  it('is not lowered just because a return is missing, which may simply not have arrived yet', async () => {
    const sale = await sold(5)
    await giveBack(sale, 2)
    // As if the return itself were still in a later batch, or quarantined.
    await editingSubmitted(fx.db, 'sales_returns', () => fx.db.execute('UPDATE sales_returns SET docstatus = 0'))

    const found = await reconcileReturnedQty(fx.db, { repair: true })
    expect(found).toEqual([{ billItemId: sale.itemId, stored: fromUnits(2), derived: 0, repairable: false }])
    expect(await returnedOn(sale.itemId)).toBe(2)
  })

  /* The bill's corrected copy arrived a batch ahead of the cancellation, so a
     merge raised the line for a return already undone. */
  it('comes down by a return whose cancellation just arrived, and no further', async () => {
    const sale = await sold(5)
    const undone = await giveBack(sale, 1)
    await giveBack(sale, 2)
    await cancelReturn(fx.db, { returnId: undone, actorId: fx.adminId })
    // Raised for the cancelled return, and the other still on its way.
    await fx.db.execute('UPDATE bill_items SET returned_qty = ? WHERE id = ?', [fromUnits(3), sale.itemId])
    await editingSubmitted(fx.db, 'sales_returns', () => fx.db.execute(
      'UPDATE sales_returns SET docstatus = 0 WHERE id <> ?', [undone]))

    const found = await reconcileReturnedQty(fx.db, { repair: true, cancelledNow: [undone] })
    expect(found).toEqual([{ billItemId: sale.itemId, stored: fromUnits(3), derived: 0, repairable: false }])
    expect(await returnedOn(sale.itemId)).toBe(2)
  })

  it('is not lowered by a cancellation it already held', async () => {
    const sale = await sold(5)
    const undone = await giveBack(sale, 1)
    await cancelReturn(fx.db, { returnId: undone, actorId: fx.adminId })
    await fx.db.execute('UPDATE bill_items SET returned_qty = ? WHERE id = ?', [fromUnits(1), sale.itemId])

    await reconcileReturnedQty(fx.db, { repair: true })
    expect(await returnedOn(sale.itemId)).toBe(1)
  })

  it('looks only at the bills it is given', async () => {
    const one = await sold(5)
    const other = await sold(5)
    await giveBack(one, 1)
    await giveBack(other, 1)
    await fx.db.execute('UPDATE bill_items SET returned_qty = 0')

    await reconcileReturnedQty(fx.db, { repair: true, billIds: [one.billId] })
    expect(await returnedOn(one.itemId)).toBe(1)
    expect(await returnedOn(other.itemId)).toBe(0)
  })
})

describe('a draft return', () => {
  it('stays off the wire until it is submitted (057)', async () => {
    const sale = await sold(3)
    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) throw new Error(ret.code)
    const fed = () => fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM change_feed WHERE table_name = 'sales_returns' AND row_id = ?`, [ret.returnId])

    expect((await fed())?.n).toBe(0)
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    expect((await fed())?.n).toBe(1)
  })
})
