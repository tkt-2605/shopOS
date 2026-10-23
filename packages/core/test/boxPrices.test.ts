import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { bootstrap } from '../src/services/bootstrap.js'
import { setUnits, setLadder, setItemPrice, unitPrices, setUnitPrices, planLadderImport, updatePriceList } from '../src/services/pricing.js'
import { isOn, setFeature } from '../src/services/features.js'
import { resolveLinePrice, pricingContextFor } from '../src/repos/pricing.js'
import { saleUnitsFor } from '../src/repos/catalog.js'
import { createBill } from '../src/services/billing.js'
import { rowsToRungs, type LadderRow } from '../src/domain/ladder.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Box prices and MRP (079): a box of ten pens printed ₹90 and sold at ₹85,
 * behind a switch that can be turned off and on without leaving a price
 * charged that nobody can see.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

/** A pen at ₹10, MRP ₹10, also sold by the box of ten. */
async function aPen() {
  const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
  await fx.db.execute('UPDATE products SET mrp = ? WHERE id = ?', [rupees(10), p])
  await setUnits(fx.db, ctx(), p, [{ saleUnit: 'box', baseUnits: fromUnits(10) }])
  return p
}

async function breaks(p: string, text: string) {
  await setFeature(fx.db, ctx(), 'tieredPricing', true)
  const rows: LadderRow[] = text.split(',').map((part) => {
    const [minQty, rate] = part.split('=')
    return { minQty: (minQty ?? '').trim(), rate: (rate ?? '').trim() }
  })
  const parsed = rowsToRungs(rows)
  if (!parsed.ok) throw new Error(parsed.code)
  const saved = await setLadder(fx.db, ctx(), { productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: parsed.rungs })
  if (!saved.ok) throw new Error(saved.code)
}

async function boxPrice(p: string, boxes = 1) {
  const pricing = await pricingContextFor(fx.db, null)
  return (await resolveLinePrice(fx.db, pricing, { productId: p, saleUnit: 'box', qty: fromUnits(boxes) })).rate
}

async function billedBox(p: string) {
  const bill = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: p, qty: fromUnits(1), saleUnit: 'box' }], actorId: fx.adminId,
  })
  if (!bill.ok) throw new Error(bill.code)
  return (await fx.db.get<{ rate: number; mrp: number | null }>('SELECT rate, mrp FROM bill_items WHERE bill_id = ?', [bill.billId]))!
}

describe('the switch', () => {
  it('starts off in a shop that has never priced a box', async () => {
    expect(await isOn(fx.db, 'unitPrices')).toBe(false)
  })

  it('on, a box sells at its own price; off, at its pieces, and on again brings the price back', async () => {
    const p = await aPen()
    await setFeature(fx.db, ctx(), 'unitPrices', true)
    const saved = await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: rupees(90), rate: rupees(85) }] })
    expect(saved).toEqual({ ok: true })
    expect(await boxPrice(p)).toBe(rupees(85))

    await setFeature(fx.db, ctx(), 'unitPrices', false)
    expect(await boxPrice(p)).toBe(rupees(100))
    // Kept, not deleted.
    expect((await unitPrices(fx.db, p))[0]).toMatchObject({ mrp: rupees(90), rate: rupees(85) })

    await setFeature(fx.db, ctx(), 'unitPrices', true)
    expect(await boxPrice(p)).toBe(rupees(85))
  })

  it('a box reaches the piece breaks only while breaks are on', async () => {
    const p = await aPen()
    await breaks(p, '10=9')
    expect(await boxPrice(p)).toBe(rupees(90))

    await setFeature(fx.db, ctx(), 'tieredPricing', false)
    // A break at ten pieces is not the price of a box of ten when breaks are off.
    expect(await boxPrice(p)).toBe(rupees(100))
  })

  it('a box with its own price does not mix in the piece breaks', async () => {
    const p = await aPen()
    await breaks(p, '10=9')
    await setFeature(fx.db, ctx(), 'unitPrices', true)
    await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: null, rate: rupees(95) }] })
    expect(await boxPrice(p)).toBe(rupees(95))
    expect(await boxPrice(p, 3)).toBe(rupees(95))
  })
})

describe('the MRP on a box line', () => {
  it('is the box’s own when it has one and the switch is on', async () => {
    const p = await aPen()
    await setFeature(fx.db, ctx(), 'unitPrices', true)
    await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: rupees(90), rate: rupees(85) }] })
    expect(await billedBox(p)).toEqual({ rate: rupees(85), mrp: rupees(90) })
    expect((await saleUnitsFor(fx.db, p)).find((u) => u.saleUnit === 'box')!.mrp).toBe(rupees(90))
  })

  it('is its pieces’ MRP times how many it holds otherwise -- per box, as the receipt reads it', async () => {
    const p = await aPen()
    expect(await billedBox(p)).toEqual({ rate: rupees(100), mrp: rupees(100) })
    expect((await saleUnitsFor(fx.db, p)).find((u) => u.saleUnit === 'box')!.mrp).toBeNull()
  })
})

describe('saving a box’s MRP and price', () => {
  beforeEach(async () => { await setFeature(fx.db, ctx(), 'unitPrices', true) })

  it('refuses a price above the MRP, and writes nothing', async () => {
    const p = await aPen()
    const saved = await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: rupees(90), rate: rupees(95) }] })
    expect(saved).toMatchObject({ ok: false, code: 'ABOVE_MRP', rate: rupees(95), mrp: rupees(90) })
    expect((await unitPrices(fx.db, p))[0]).toMatchObject({ mrp: null, rate: null })
  })

  it('refuses an MRP the box would be charged over as its pieces', async () => {
    const p = await aPen()
    const saved = await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: rupees(90), rate: null }] })
    expect(saved).toMatchObject({ ok: false, code: 'PIECES_ABOVE_MRP', rate: rupees(100), mrp: rupees(90) })
  })

  it('takes that MRP when the piece breaks bring the box under it', async () => {
    const p = await aPen()
    await breaks(p, '10=9')
    const saved = await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: rupees(90), rate: null }] })
    expect(saved).toEqual({ ok: true })
    expect((await unitPrices(fx.db, p))[0]).toMatchObject({ mrp: rupees(90), rate: null, asPieces: rupees(90) })
  })

  it('clearing the price leaves the box’s own breaks from the CSV alone', async () => {
    const p = await aPen()
    await setFeature(fx.db, ctx(), 'tieredPricing', true)
    await setItemPrice(fx.db, ctx(), { productId: p, priceListId: fx.seed.priceListId, saleUnit: 'box', minQty: fromUnits(1), rate: rupees(85) })
    await setItemPrice(fx.db, ctx(), { productId: p, priceListId: fx.seed.priceListId, saleUnit: 'box', minQty: fromUnits(5), rate: rupees(80) })
    await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: null, rate: null }] })
    expect(await boxPrice(p, 5)).toBe(rupees(80))
    expect(await boxPrice(p, 1)).toBe(rupees(100))
  })
})

describe('a shop list that quotes before GST', () => {
  it('stores the box price before GST, reads it back as typed, and charges it with GST in', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(118), taxRateBp: 1800 })
    await setUnits(fx.db, ctx(), p, [{ saleUnit: 'box', baseUnits: fromUnits(10) }])
    const changed = await updatePriceList(fx.db, ctx(), { priceListId: fx.seed.priceListId, ratesIncludeTax: false })
    expect(changed.ok).toBe(true)
    await setFeature(fx.db, ctx(), 'unitPrices', true)

    expect(await setUnitPrices(fx.db, ctx(), { productId: p, units: [{ saleUnit: 'box', mrp: rupees(1180), rate: rupees(1062) }] })).toEqual({ ok: true })
    const row = await fx.db.get<{ rate: number }>(`SELECT rate FROM item_prices WHERE product_id = ? AND sale_unit = 'box' AND deleted_at IS NULL`, [p])
    expect(row!.rate).toBe(rupees(900))
    expect((await unitPrices(fx.db, p))[0]).toMatchObject({ rate: rupees(1062), asPieces: rupees(1180) })

    const pricing = await pricingContextFor(fx.db, null)
    const line = await resolveLinePrice(fx.db, pricing, { productId: p, saleUnit: 'box', qty: fromUnits(1) })
    expect(line).toMatchObject({ rate: rupees(900), includesTax: false })
  })
})

describe('the CSV', () => {
  it('will not take a box price for everyone while the switch is off', async () => {
    await aPen()
    const plan = await planLadderImport(fx.db, 'item,unit,min_qty,rate\nPen,box,1,85\n')
    expect(plan.problems.map((x) => x.problem)).toEqual(['UNIT_PRICES_OFF'])
    expect(plan.ladders).toEqual([])

    await setFeature(fx.db, ctx(), 'unitPrices', true)
    const again = await planLadderImport(fx.db, 'item,unit,min_qty,rate\nPen,box,1,85\n')
    expect(again.problems).toEqual([])
    expect(again.ladders).toHaveLength(1)
  })
})

describe('migration 079', () => {
  async function before79() {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version < 79))
    const seed = await bootstrap(db, { shopName: 'Box Shop' })
    const now = new Date().toISOString()
    const p = newId()
    await db.execute(`INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at) VALUES (?, 'Pen', 1000, 0, ?, ?)`, [p, now, now])
    await db.execute(
      `INSERT INTO product_units (id, product_id, sale_unit, base_units, created_at, updated_at) VALUES (?, ?, 'box', ?, ?, ?)`,
      [newId(), p, fromUnits(10), now, now],
    )
    return { db, seed, p, now }
  }

  it('turns box prices on for a shop already charging a box price, so it goes on being charged', async () => {
    const { db, seed, p, now } = await before79()
    await db.execute(
      `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, created_at, updated_at)
       VALUES (?, ?, ?, 'box', ?, 8500, ?, ?)`,
      [newId(), p, seed.priceListId, fromUnits(1), now, now],
    )
    await migrate(db, MIGRATIONS)
    expect(await isOn(db, 'unitPrices')).toBe(true)
    await db.close()
  })

  it('leaves it off for every other shop', async () => {
    const { db } = await before79()
    await migrate(db, MIGRATIONS)
    expect(await isOn(db, 'unitPrices')).toBe(false)
    await db.close()
  })
})
