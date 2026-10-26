import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setUnits, setItemPrice, setCustomerPrice, renameBaseUnit, listItemPrices, planLadderImport,
} from '../src/services/pricing.js'
import { saleUnitsFor } from '../src/repos/catalog.js'
import { resolveLinePrice, pricingContextFor, resolveSaleUnit } from '../src/repos/pricing.js'
import { createBill } from '../src/services/billing.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { setFeature } from '../src/services/features.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Renaming the unit an item is counted in: piece as pcs. Only the word moves;
 * every quantity means what it did, and the old word goes on meaning one.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

/** A pen at ₹10 a piece, a box of ten, ₹9 on the shop's list from ten, and ₹8 for one customer. */
async function aPen() {
  await setFeature(fx.db, ctx(), 'tieredPricing', true)
  const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
  await setUnits(fx.db, ctx(), p, [{ saleUnit: 'box', baseUnits: fromUnits(10) }])
  const listed = await setItemPrice(fx.db, ctx(), { productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', minQty: fromUnits(10), rate: rupees(9) })
  if (!listed.ok) throw new Error(listed.code)
  const customer = await makeCustomer(fx.db, 'Office')
  const own = await setCustomerPrice(fx.db, ctx(), { customerId: customer, productId: p, saleUnit: 'piece', rate: rupees(8) })
  if (!own.ok) throw new Error(own.code)
  return { p, customer }
}

async function bill(p: string, saleUnit: string, units: number, customerId: string | null = null) {
  const made = await createBill(fx.db, {
    registerId: fx.seed.registerId, customerId, actorId: fx.adminId,
    lines: [{ productId: p, qty: fromUnits(units), saleUnit }],
  })
  if (!made.ok) throw new Error(made.code)
  return (await fx.db.get<{ sale_unit: string; rate: number; base_qty: number }>(
    'SELECT sale_unit, rate, base_qty FROM bill_items WHERE bill_id = ?', [made.billId],
  ))!
}

describe('renaming the unit an item is counted in', () => {
  it('changes the word and nothing it counts: prices move with it, and a box is still ten', async () => {
    const { p, customer } = await aPen()
    const before = await bill(p, 'piece', 3)

    expect(await renameBaseUnit(fx.db, ctx(), { productId: p, name: 'pcs' })).toEqual({ ok: true, from: 'piece', to: 'pcs' })

    expect((await fx.db.get<{ base_unit: string }>('SELECT base_unit FROM products WHERE id = ?', [p]))!.base_unit).toBe('pcs')
    expect((await listItemPrices(fx.db, { productId: p })).map((r) => r.saleUnit)).toEqual(['pcs'])
    const pricing = await pricingContextFor(fx.db, null)
    expect((await resolveLinePrice(fx.db, pricing, { productId: p, saleUnit: 'pcs', qty: fromUnits(10) })).rate).toBe(rupees(9))
    expect((await resolveLinePrice(fx.db, await pricingContextFor(fx.db, customer), { productId: p, saleUnit: 'pcs', qty: fromUnits(1) })).rate).toBe(rupees(8))
    expect(await bill(p, 'box', 1)).toEqual({ sale_unit: 'box', rate: rupees(90), base_qty: fromUnits(10) })
    expect(await bill(p, 'pcs', 3)).toEqual({ sale_unit: 'pcs', rate: rupees(10), base_qty: fromUnits(3) })

    // The bill from before keeps the word it was written with.
    expect(before.sale_unit).toBe('piece')
    expect((await fx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bill_items WHERE sale_unit = 'piece'`))!.n).toBe(1)
  })

  it('lets the old word go on meaning one of it -- a held bill, a quotation, an old price file', async () => {
    const { p } = await aPen()
    await renameBaseUnit(fx.db, ctx(), { productId: p, name: 'pcs' })

    expect(await resolveSaleUnit(fx.db, p, 'piece')).toEqual({ saleUnit: 'pcs', baseUnits: fromUnits(1) })
    expect(await bill(p, 'piece', 10)).toEqual({ sale_unit: 'pcs', rate: rupees(9), base_qty: fromUnits(10) })

    const plan = await planLadderImport(fx.db, 'item,unit,min_qty,rate\nPen,piece,20,8.50\n')
    expect(plan.problems).toEqual([])
    expect(plan.ladders[0]).toMatchObject({ saleUnit: 'pcs' })
  })

  it('never offers the old word at the counter, and will not let it come back as some other unit', async () => {
    const { p } = await aPen()
    await renameBaseUnit(fx.db, ctx(), { productId: p, name: 'pcs' })
    expect((await saleUnitsFor(fx.db, p)).map((u) => u.saleUnit)).toEqual(['pcs', 'box'])

    const reused = await setUnits(fx.db, ctx(), p, [
      { saleUnit: 'box', baseUnits: fromUnits(10) }, { saleUnit: 'piece', baseUnits: fromUnits(12) },
    ])
    expect(reused).toEqual({ ok: false, code: 'WAS_THE_BASE', saleUnit: 'piece' })
  })

  it('refuses a word the item already sells in, or no word at all', async () => {
    const { p } = await aPen()
    expect(await renameBaseUnit(fx.db, ctx(), { productId: p, name: 'box' })).toEqual({ ok: false, code: 'NAME_TAKEN', name: 'box' })
    expect(await renameBaseUnit(fx.db, ctx(), { productId: p, name: '  ' })).toEqual({ ok: false, code: 'BAD_NAME' })
    expect((await fx.db.get<{ base_unit: string }>('SELECT base_unit FROM products WHERE id = ?', [p]))!.base_unit).toBe('piece')
  })

  it('can be renamed back, and both old words still mean one', async () => {
    const { p } = await aPen()
    await renameBaseUnit(fx.db, ctx(), { productId: p, name: 'pcs' })
    expect(await renameBaseUnit(fx.db, ctx(), { productId: p, name: 'piece' })).toEqual({ ok: true, from: 'pcs', to: 'piece' })
    expect((await listItemPrices(fx.db, { productId: p })).map((r) => r.saleUnit)).toEqual(['piece'])
    expect(await bill(p, 'pcs', 2)).toEqual({ sale_unit: 'piece', rate: rupees(10), base_qty: fromUnits(2) })
    expect((await saleUnitsFor(fx.db, p)).map((u) => u.saleUnit)).toEqual(['piece', 'box'])
  })

  it('is written to the history', async () => {
    const { p } = await aPen()
    await renameBaseUnit(fx.db, ctx(), { productId: p, name: 'pcs' })
    const row = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`, [p],
    )
    expect(row!.diff).toContain('piece')
    expect(row!.diff).toContain('pcs')
  })
})
