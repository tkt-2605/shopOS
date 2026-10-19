import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createUser } from '../src/services/auth.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { saveProductDetails } from '../src/services/products.js'
import { setItemPrice } from '../src/services/pricing.js'
import { setLadder } from '../src/services/pricing/ladders.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { planImport } from '../src/services/import.js'
import { defaultPriceListId } from '../src/repos/pricing.js'
import { setSetting } from '../src/services/settings.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Nothing sells, and nothing is priced to sell, below what it cost -- unless
 * a role allowed to says so, and then it is on the record (`belowCost.ts`).
 *
 * The item here sells at ₹100 with no GST, and cost ₹80 a piece.
 */

let fx: Fixture
let pen: string

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100), taxRateBp: 0 })
  await bought(pen, rupees(80))
})
afterEach(async () => { await fx.db.close() })

async function bought(productId: string, unitCost: Money, taxRateBp = 0) {
  const entry = await createStockEntry(fx.db, {
    entryType: 'purchase', reference: '', actorId: fx.adminId,
    lines: [{ productId, qty: fromUnits(10), unitCost, taxRateBp }],
  })
  if (!entry.ok) throw new Error(entry.code)
  const done = await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
}

async function staff(role: string): Promise<string> {
  const made = await createUser(fx.db, {
    username: role.toLowerCase(), password: 'counter-9', roleId: fx.seed.roleIds[role]!, actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(made.code)
  return made.userId
}

async function ringUp(actorId: string, opts: { discount?: Money; productId?: string } = {}) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId: opts.productId ?? pen, qty: fromUnits(1) }],
    ...(opts.discount ? { billDiscount: opts.discount } : {}),
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  return {
    pay: (allow?: boolean) => submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId,
      ...(allow === undefined ? {} : { allowBelowCost: allow }),
    }),
  }
}

const details = (rate: Money, extra: Partial<Parameters<typeof saveProductDetails>[2]> = {}) =>
  saveProductDetails(fx.db, { actorId: fx.adminId }, {
    id: pen, name: 'Pen', brand: null, hsnCode: null, taxRateBp: 0, baseRate: rate, mrp: null,
    baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false,
    isStockTracked: true, reorderLevel: null, reorderQty: null, ...extra,
  })

describe('at the counter', () => {
  it('sells at or above cost as it always has', async () => {
    expect((await (await ringUp(fx.adminId)).pay()).ok).toBe(true)
  })

  it('refuses a discount that takes a line below cost, and says which and by how much', async () => {
    const cashier = await staff('Cashier')
    const done = await (await ringUp(cashier, { discount: rupees(30) })).pay()
    expect(done).toMatchObject({
      ok: false, code: 'BELOW_COST', mayAllow: false,
      lines: [{ productId: pen, name: 'Pen', sellsAt: rupees(70), cost: rupees(80) }],
    })
  })

  it('will not let a cashier past it even by asking', async () => {
    const cashier = await staff('Cashier')
    const done = await (await ringUp(cashier, { discount: rupees(30) })).pay(true)
    expect(done).toMatchObject({ ok: false, code: 'BELOW_COST', mayAllow: false })
  })

  it('lets the owner go ahead once they say so, and records it against the bill', async () => {
    const bill = await ringUp(fx.adminId, { discount: rupees(30) })
    expect(await bill.pay()).toMatchObject({ ok: false, code: 'BELOW_COST', mayAllow: true })
    const done = await bill.pay(true)
    expect(done.ok).toBe(true)
    const audit = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity = 'bills' AND diff LIKE '%below_cost%'`,
    )
    expect(audit?.diff).toContain('Pen: 70.00 under 80.00')
  })

  it('never refuses an item whose cost it does not know', async () => {
    const loose = await makeProduct(fx.db, { name: 'Loose', baseRate: rupees(5), taxRateBp: 0 })
    const cashier = await staff('Cashier')
    expect((await (await ringUp(cashier, { productId: loose })).pay()).ok).toBe(true)
  })

  it('holds a shop that cannot claim input tax to its cost with the supplier’s GST in it', async () => {
    // Bought at ₹80 + 18%: ₹94.40 a piece is what it really cost a composition shop.
    const book = await makeProduct(fx.db, { name: 'Book', baseRate: rupees(90), taxRateBp: 1800 })
    await setSetting(fx.db, 'shop_tax_scheme', 'composition')
    await bought(book, rupees(80), 1800)
    const cashier = await staff('Cashier')
    expect(await (await ringUp(cashier, { productId: book })).pay())
      .toMatchObject({ ok: false, code: 'BELOW_COST', lines: [{ cost: rupees(94.4) }] })
  })
})

describe('setting a selling rate', () => {
  it('refuses the item’s rate below cost, and saves nothing', async () => {
    expect(await details(rupees(70))).toMatchObject({ ok: false, code: 'BELOW_COST', mayAllow: true })
    const row = await fx.db.get<{ base_rate: number }>('SELECT base_rate FROM products WHERE id = ?', [pen])
    expect(row?.base_rate).toBe(rupees(100))
  })

  it('saves it when the owner allows it', async () => {
    expect(await details(rupees(70), { allowBelowCost: true })).toMatchObject({ ok: true })
  })

  it('still lets an item already under cost be renamed', async () => {
    await bought(pen, rupees(120))
    const renamed = await saveProductDetails(fx.db, { actorId: fx.adminId }, {
      id: pen, name: 'Blue pen', brand: null, hsnCode: null, taxRateBp: 0, baseRate: rupees(100), mrp: null,
      baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false,
      isStockTracked: true, reorderLevel: null, reorderQty: null,
    })
    expect(renamed.ok).toBe(true)
  })

  it('refuses a price-list rate below cost', async () => {
    const listId = (await defaultPriceListId(fx.db))!
    expect(await setItemPrice(fx.db, { actorId: fx.adminId }, {
      productId: pen, priceListId: listId, saleUnit: 'piece', rate: rupees(60),
    })).toMatchObject({ ok: false, code: 'BELOW_COST' })
  })

  it('refuses a whole ladder with one rung below cost, and writes none of it', async () => {
    const listId = (await defaultPriceListId(fx.db))!
    const ladder = await setLadder(fx.db, { actorId: fx.adminId }, {
      productId: pen, priceListId: listId, saleUnit: 'piece',
      rungs: [{ minQty: fromUnits(1), rate: rupees(95) }, { minQty: fromUnits(10), rate: rupees(75) }],
    })
    expect(ladder).toMatchObject({ ok: false, code: 'BELOW_COST', lines: [{ sellsAt: rupees(75) }] })
    const rows = await fx.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM item_prices WHERE product_id = ? AND deleted_at IS NULL', [pen],
    )
    expect(rows?.n).toBe(0)
  })
})

describe('a delivery', () => {
  it('refuses a price given to its batch below what this delivery cost', async () => {
    const entry = await createStockEntry(fx.db, {
      entryType: 'purchase', reference: '', actorId: fx.adminId,
      lines: [{ productId: pen, qty: fromUnits(5), unitCost: rupees(90), saleRate: rupees(85) }],
    })
    expect(entry).toMatchObject({ ok: false, code: 'BELOW_COST', lines: [{ cost: rupees(90) }] })
  })

  it('records a delivery that simply costs more than the item sells for', async () => {
    // A stock entry that refuses is a shelf that goes uncounted; the counter catches the sale.
    const entry = await createStockEntry(fx.db, {
      entryType: 'purchase', reference: '', actorId: fx.adminId,
      lines: [{ productId: pen, qty: fromUnits(5), unitCost: rupees(120) }],
    })
    expect(entry.ok).toBe(true)
  })
})

describe('a catalogue file', () => {
  it('skips a row whose rate is below cost, new or already here', async () => {
    const plan = await planImport(fx.db, [
      'name,rate,cost',
      'Pen,60,',
      `Stapler ${newId().slice(0, 4)},40,50`,
      'Ruler,30,20',
    ].join('\n'))
    expect(plan.rows.map((r) => r.problem)).toEqual(['BELOW_COST', 'BELOW_COST', null])
  })
})
