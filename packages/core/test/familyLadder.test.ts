import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setLadder, setCustomerLadder } from '../src/services/pricing.js'
import { addVersions, setFamilyPrice } from '../src/services/variants.js'
import { setFeature } from '../src/services/features.js'
import { loadPriceCandidates, defaultPriceListId } from '../src/repos/pricing.js'
import { resolvePrice } from '../src/domain/pricing.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Cheaper by quantity on a family priced as one: the breaks are written on the
 * pen, and the blue pen sells by them. Before this the blue pen took the
 * pen's rate but none of its breaks, because those are rows of the pen's own.
 */

let fx: Fixture
let pen: string
let blue: string
let everyone: string
const ctx = () => ({ actorId: fx.adminId })
const rungs = (pairs: [number, number][]) => pairs.map(([q, r]) => ({ minQty: fromUnits(q), rate: rupees(r) }))

beforeEach(async () => {
  fx = await freshDb()
  await setFeature(fx.db, ctx(), 'tieredPricing', true)
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
  everyone = (await defaultPriceListId(fx.db))!
  await setLadder(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rungs: rungs([[1, 10], [10, 9], [50, 8]]) })
  const made = await addVersions(fx.db, ctx(), { parentId: pen, labels: ['Blue', 'Red'] })
  if (!made.ok) throw new Error(made.code)
  blue = made.created[0]!.id
})
afterEach(async () => { await fx.db.close() })

async function rateOf(productId: string, units: number, customerId: string | null = null) {
  const candidates = await loadPriceCandidates(fx.db, { productId, saleUnit: 'piece', customerId, defaultPriceListId: everyone })
  return resolvePrice(candidates, fromUnits(units), new Date()).rate
}

describe('a variant in a family priced as one', () => {
  it("sells by the family's quantity breaks", async () => {
    expect(await rateOf(blue, 1)).toBe(rupees(10))
    expect(await rateOf(blue, 10)).toBe(rupees(9))
    expect(await rateOf(blue, 60)).toBe(rupees(8))
  })

  it("takes a customer's own breaks written on the family", async () => {
    const customer = await makeCustomer(fx.db)
    await setCustomerLadder(fx.db, ctx(), { customerId: customer, productId: pen, saleUnit: 'piece', rungs: rungs([[1, 9.5], [20, 7]]) })
    expect(await rateOf(blue, 20, customer)).toBe(rupees(7))
  })

  it('a rate written for that one colour comes first, and the family still gives the breaks it has not', async () => {
    const customer = await makeCustomer(fx.db)
    await setCustomerLadder(fx.db, ctx(), { customerId: customer, productId: blue, saleUnit: 'piece', rungs: rungs([[1, 9.75]]) })
    expect(await rateOf(blue, 1, customer)).toBe(rupees(9.75))
    expect(await rateOf(blue, 60)).toBe(rupees(8))
  })

  it('priced on its own, it keeps to its own rows', async () => {
    await setFamilyPrice(fx.db, ctx(), pen, false)
    expect(await rateOf(blue, 10)).toBe(rupees(10))
  })
})
