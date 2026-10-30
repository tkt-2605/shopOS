import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openCount, loadCount, setCounted, submitCount } from '../src/services/stockCount.js'
import { addToCount } from '../src/services/stockCountAdd.js'
import { currentStock, postMovement } from '../src/services/stock.js'
import { type Money } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'

/**
 * Items the sheet did not have: one at zero when the sheet was opened without
 * them, and one added to the catalogue while the counting went on.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockUp(productId: string, units: number, cost = 5000): Promise<void> {
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId, qtyChange: fromUnits(units), unitCost: cost as Money,
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    })
  })
}

async function openAll(includeEmpty = false) {
  const opened = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId, includeEmpty })
  if (!opened.ok) throw new Error(opened.code)
  return opened.countId
}

describe('the whole shop on one sheet', () => {
  it('puts items at zero on it when asked, as the count screen asks', async () => {
    const stocked = await makeProduct(fx.db, { name: 'Stocked' })
    await stockUp(stocked, 4)
    const empty = await makeProduct(fx.db, { name: 'Never entered' })
    const sheet = await loadCount(fx.db, await openAll(true))
    expect(sheet!.lines.map((l) => l.productId).sort()).toEqual([stocked, empty].sort())
  })
})

describe('adding an item to an open sheet', () => {
  it('adds one made after the sheet opened, at what the system holds now, and posts it', async () => {
    const first = await makeProduct(fx.db, { name: 'First' })
    await stockUp(first, 2)
    const countId = await openAll()
    const later = await makeProduct(fx.db, { name: 'Added later' })
    await stockUp(later, 3)

    const added = await addToCount(fx.db, { countId, productId: later, actorId: fx.adminId })
    expect(added).toMatchObject({ ok: true })
    const line = (await loadCount(fx.db, countId))!.lines.find((l) => l.productId === later)!
    expect(toUnits(line.expectedQty)).toBe(3)
    expect(line.unitCost).toBe(5000)

    await setCounted(fx.db, { countId, productId: later, countedQty: fromUnits(5) })
    expect(await submitCount(fx.db, { countId, actorId: fx.adminId })).toMatchObject({ ok: true, surpluses: 1 })
    expect(toUnits(await currentStock(fx.db, later))).toBe(5)
  })

  it('adds an item at zero, which comes in at no value', async () => {
    await stockUp(await makeProduct(fx.db), 1)
    const countId = await openAll()
    const empty = await makeProduct(fx.db, { name: 'Never entered' })
    expect(await addToCount(fx.db, { countId, productId: empty, actorId: fx.adminId }))
      .toMatchObject({ ok: true, expectedQty: 0 })
    const line = (await loadCount(fx.db, countId))!.lines.find((l) => l.productId === empty)!
    expect(line.unitCost).toBeNull()
  })

  it('refuses a second line for the same item, a retired item, and a posted sheet', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(p, 2)
    const countId = await openAll()
    expect(await addToCount(fx.db, { countId, productId: p, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'ALREADY_ON_SHEET' })

    const retired = await makeProduct(fx.db, { name: 'Retired' })
    await fx.db.execute('UPDATE products SET is_active = 0 WHERE id = ?', [retired])
    expect(await addToCount(fx.db, { countId, productId: retired, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NOT_COUNTABLE' })

    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(2) })
    await submitCount(fx.db, { countId, actorId: fx.adminId })
    const late = await makeProduct(fx.db, { name: 'Too late' })
    expect(await addToCount(fx.db, { countId, productId: late, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NOT_OPEN' })
  })
})
