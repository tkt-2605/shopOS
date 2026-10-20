import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createUser } from '../src/services/auth.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { saveProductDetails } from '../src/services/products.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { netPerBase, soldPerBase, floorOf } from '../src/domain/costFloor.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, qty, QTY_SCALE } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * The edges of the below-cost rule (`services/belowCost.ts`): a price exactly
 * at cost, a discount shared across lines and units, a refusal that changes
 * nothing, and a cost price newer than the last delivery raising the floor.
 *
 * Pen sells at ₹100 and cost ₹80; Book sells at ₹100 and cost ₹10. No GST.
 */

let fx: Fixture
let pen: string
let book: string

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100), taxRateBp: 0 })
  book = await makeProduct(fx.db, { name: 'Book', baseRate: rupees(100), taxRateBp: 0 })
  await bought(pen, rupees(80))
  await bought(book, rupees(10))
})
afterEach(async () => { await fx.db.close() })

async function bought(productId: string, unitCost: Money) {
  const entry = await createStockEntry(fx.db, {
    entryType: 'purchase', reference: '', actorId: fx.adminId,
    lines: [{ productId, qty: fromUnits(10), unitCost, taxRateBp: 0 }],
  })
  if (!entry.ok) throw new Error(entry.code)
  const done = await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
}

async function bill(lines: { productId: string; units: number }[], discount?: Money) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: lines.map((l) => ({ productId: l.productId, qty: fromUnits(l.units) })),
    ...(discount ? { billDiscount: discount } : {}),
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  return {
    billId: draft.billId,
    pay: (actorId = fx.adminId, allow?: boolean) => submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId,
      ...(allow === undefined ? {} : { allowBelowCost: allow }),
    }),
  }
}

describe('the floor itself', () => {
  it('lets a sale exactly at cost through, and refuses one a paisa under', async () => {
    expect(await (await bill([{ productId: pen, units: 1 }], rupees(20))).pay()).toMatchObject({ ok: true })
    expect(await (await bill([{ productId: pen, units: 1 }], (rupees(20) + 1) as Money)).pay())
      .toMatchObject({ ok: false, code: 'BELOW_COST', lines: [{ sellsAt: rupees(80) - 1, cost: rupees(80) }] })
  })

  it('holds each unit to the cost, not the line, when several are sold', async () => {
    expect(await (await bill([{ productId: pen, units: 3 }], rupees(60))).pay()).toMatchObject({ ok: true })
    expect(await (await bill([{ productId: pen, units: 3 }], rupees(63))).pay())
      .toMatchObject({ ok: false, code: 'BELOW_COST', lines: [{ sellsAt: rupees(79), cost: rupees(80) }] })
  })

  it('names only the line the discount takes under, on a bill with others well above', async () => {
    const result = await (await bill([{ productId: pen, units: 1 }, { productId: book, units: 1 }], rupees(50))).pay()
    expect(result).toMatchObject({ ok: false, code: 'BELOW_COST' })
    if (result.ok || result.code !== 'BELOW_COST') throw new Error('expected a refusal')
    expect(result.lines.map((l) => l.name)).toEqual(['Pen'])
  })

  it('is raised by a cost price typed after the last delivery', async () => {
    const saved = await saveProductDetails(fx.db, { actorId: fx.adminId }, {
      id: pen, name: 'Pen', brand: null, hsnCode: null, taxRateBp: 0, baseRate: rupees(100), mrp: null,
      baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false,
      isStockTracked: true, reorderLevel: null, reorderQty: null, costPrice: rupees(90),
    })
    expect(saved.ok).toBe(true)
    expect(await (await bill([{ productId: pen, units: 1 }], rupees(15))).pay())
      .toMatchObject({ ok: false, code: 'BELOW_COST', lines: [{ cost: rupees(90) }] })
  })
})

describe('a refusal', () => {
  it('leaves the bill a draft, the shelf as it was and nothing on the audit trail', async () => {
    const before = await fx.db.get<{ q: number }>('SELECT SUM(qty_change) AS q FROM stock_ledger WHERE product_id = ?', [pen])
    const b = await bill([{ productId: pen, units: 1 }], rupees(30))
    expect(await b.pay()).toMatchObject({ ok: false, code: 'BELOW_COST' })
    expect((await fx.db.get<{ d: number }>('SELECT docstatus AS d FROM bills WHERE id = ?', [b.billId]))?.d).toBe(0)
    expect((await fx.db.get<{ q: number }>('SELECT SUM(qty_change) AS q FROM stock_ledger WHERE product_id = ?', [pen]))?.q)
      .toBe(before?.q)
    expect((await fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'bills' AND entity_id = ? AND diff LIKE '%below_cost%'`, [b.billId],
    ))?.n).toBe(0)
  })

  it('is not lifted for a cashier who sends allow anyway, and the same bill pays once the owner allows it', async () => {
    const made = await createUser(fx.db, {
      username: 'cashier', password: 'counter-9', roleId: fx.seed.roleIds['Cashier']!, actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(made.code)
    const b = await bill([{ productId: pen, units: 1 }], rupees(30))
    expect(await b.pay(made.userId, true)).toMatchObject({ ok: false, code: 'BELOW_COST', mayAllow: false })
    expect(await b.pay(fx.adminId, true)).toMatchObject({ ok: true })
    expect((await fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'bills' AND entity_id = ? AND diff LIKE '%below_cost%'`, [b.billId],
    ))?.n).toBe(1)
  })
})

describe('the arithmetic (domain/costFloor.ts)', () => {
  const box = qty(12 * QTY_SCALE)

  it('works a box rate down to one piece', () => {
    expect(netPerBase({ rate: rupees(120), includesTax: false, taxRateBp: 0, cessRateBp: 0, baseUnits: box, charges: true }))
      .toBe(rupees(10))
  })

  it('takes GST and cess out of a rate that has them in, only where the shop charges GST', () => {
    const typed = { rate: rupees(140), includesTax: true, taxRateBp: 2800, cessRateBp: 1200, baseUnits: qty(QTY_SCALE) }
    expect(netPerBase({ ...typed, charges: true })).toBe(rupees(100))
    expect(netPerBase({ ...typed, charges: false })).toBe(rupees(140))
  })

  it('leaves a rate before GST alone', () => {
    expect(netPerBase({ rate: rupees(100), includesTax: false, taxRateBp: 1800, cessRateBp: 0, baseUnits: qty(QTY_SCALE), charges: true }))
      .toBe(rupees(100))
  })

  it('has no price per unit for nothing sold, so a return is never held to the cost', () => {
    expect(soldPerBase(rupees(50), qty(0))).toBeNull()
    expect(soldPerBase(rupees(-50), qty(-QTY_SCALE))).toBeNull()
    expect(soldPerBase(rupees(30), qty(3 * QTY_SCALE))).toBe(rupees(10))
  })

  it('adds the supplier’s GST to the floor only where it cannot be claimed back', () => {
    expect(floorOf(rupees(100), rupees(18), true)).toBe(rupees(100))
    expect(floorOf(rupees(100), rupees(18), false)).toBe(rupees(118))
  })
})
