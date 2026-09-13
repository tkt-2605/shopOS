import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  rowsToRungs, rungsToRows, describeLadder, risingRungs, type LadderRow,
} from '../src/domain/ladder.js'
import {
  setLadder, setCustomerLadder, ladderFor, customerLadderFor, laddersFor, setUnits,
} from '../src/services/pricing.js'
import { loadPriceCandidates } from '../src/repos/pricing.js'
import { resolvePrice } from '../src/domain/pricing.js'
import { rupees } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

/** `1=10, 10=9` as the two boxes a screen actually offers. */
function rows(text: string): LadderRow[] {
  return text.split(',').map((part) => {
    const [minQty, rate] = part.split('=')
    return { minQty: (minQty ?? '').trim(), rate: (rate ?? '').trim() }
  })
}

function rungs(text: string) {
  const parsed = rowsToRungs(rows(text))
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.rungs
}

describe('the rungs as they are typed', () => {
  it('reads one is ten, ten is nine, fifty is eight', () => {
    const parsed = rowsToRungs(rows('1=10, 10=9, 50=8'))
    if (!parsed.ok) throw new Error(parsed.code)

    expect(parsed.rungs.map((r) => [toUnits(r.minQty), r.rate]))
      .toEqual([[1, rupees(10)], [10, rupees(9)], [50, rupees(8)]])
  })

  it('puts them in the order they apply, however they were entered', () => {
    const parsed = rowsToRungs(rows('50=8, 1=10, 10=9'))
    if (!parsed.ok) throw new Error(parsed.code)
    expect(parsed.rungs.map((r) => toUnits(r.minQty))).toEqual([1, 10, 50])
  })

  it('takes paise and fractional quantities, for things sold by weight', () => {
    const parsed = rowsToRungs(rows('0.5=30.50, 1=55'))
    if (!parsed.ok) throw new Error(parsed.code)
    expect(toUnits(parsed.rungs[0]!.minQty)).toBe(0.5)
    expect(parsed.rungs[0]!.rate).toBe(3050)
  })

  /* A quantity with no price beside it would otherwise be dropped in silence,
     and a ladder missing a rung sells at the wrong price all week. */
  it('refuses a row with only one box filled', () => {
    const half = rowsToRungs([{ minQty: '10', rate: '' }])
    if (half.ok) throw new Error('expected a refusal')
    expect(half.code).toBe('HALF_ROW')
    expect(half.index).toBe(0)

    const other = rowsToRungs([{ minQty: '', rate: '9' }])
    expect(other.ok).toBe(false)
  })

  it('ignores a row with neither box filled', () => {
    const parsed = rowsToRungs([{ minQty: '1', rate: '10' }, { minQty: '', rate: '' }])
    if (!parsed.ok) throw new Error(parsed.code)
    expect(parsed.rungs).toHaveLength(1)
  })

  it('says which row is wrong, not just that something is', () => {
    const bad = rowsToRungs([{ minQty: '1', rate: '10' }, { minQty: 'ten', rate: '9' }])
    if (bad.ok) throw new Error('expected a refusal')
    expect(bad.code).toBe('BAD_QTY')
    expect(bad.index).toBe(1)

    const price = rowsToRungs([{ minQty: '1', rate: 'free' }])
    if (price.ok) throw new Error('expected a refusal')
    expect(price.code).toBe('BAD_RATE')
  })

  it('refuses the same quantity twice, which has no answer', () => {
    const result = rowsToRungs(rows('10=9, 10=8'))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('REPEATED_QTY')
    expect(result.index).toBe(1)
  })

  it('reads an empty set of rows as no ladder at all', () => {
    const parsed = rowsToRungs([])
    if (!parsed.ok) throw new Error(parsed.code)
    expect(parsed.rungs).toEqual([])
  })

  it('goes back into the boxes it came out of', () => {
    expect(rungsToRows(rungs('10=9, 1=10'))).toEqual([
      { minQty: '1', rate: '10' },
      { minQty: '10', rate: '9' },
    ])
  })

  /* Money.format groups in the Indian style, so a ₹1,200 rung would come back
     into the box as "1,200.00" and read as something other than a number. */
  it('puts a four-figure price back without a comma in it', () => {
    const back = rungsToRows(rungs('1=1200, 10=1150.50'))
    expect(back).toEqual([
      { minQty: '1', rate: '1200' },
      { minQty: '10', rate: '1150.50' },
    ])
    const again = rowsToRungs(back)
    if (!again.ok) throw new Error(again.code)
    expect(again.rungs.map((r) => r.rate)).toEqual([rupees(1200), 115050])
  })

  it('writes itself out for a column', () => {
    expect(describeLadder(rungs('1=10, 10=9'))).toBe('1=₹10 · 10=₹9')
  })
})

describe('a ladder that charges more for buying more', () => {
  /* Almost always 90 where 9 was meant — but a shop may genuinely price a loose
     unit above a sealed box, so it is said out loud rather than refused. */
  it('is pointed out rather than refused', () => {
    expect(risingRungs(rungs('1=10, 10=9'))).toHaveLength(0)
    expect(risingRungs(rungs('1=10, 10=90')).map((r) => r.rate)).toEqual([rupees(90)])
  })
})

describe('a ladder saved against an item', () => {
  it('is the ladder the counter then charges', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(12) })
    const saved = await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10, 10=9, 50=8'),
    })
    if (!saved.ok) throw new Error(saved.code)
    expect(saved.rungs).toBe(3)

    const candidates = await loadPriceCandidates(fx.db, {
      productId: p, saleUnit: 'piece', defaultPriceListId: fx.seed.priceListId,
      customerId: null, customerPriceListId: null,
    })
    expect(resolvePrice(candidates, fromUnits(1)).rate).toBe(rupees(10))
    expect(resolvePrice(candidates, fromUnits(10)).rate).toBe(rupees(9))
    expect(resolvePrice(candidates, fromUnits(60)).rate).toBe(rupees(8))
  })

  it('reads back in the form it was typed', async () => {
    const p = await makeProduct(fx.db)
    await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10, 10=9'),
    })
    const back = await ladderFor(fx.db, {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece',
    })
    expect(rungsToRows(back)).toEqual([{ minQty: '1', rate: '10' }, { minQty: '10', rate: '9' }])
  })

  /* What is typed is the ladder, not an addition to whatever was there — a rung
     nobody can see would quietly undercut the rest. */
  it('replaces the whole ladder rather than adding to it', async () => {
    const p = await makeProduct(fx.db)
    await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10, 10=9, 50=8'),
    })
    const second = await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=11'),
    })
    if (!second.ok) throw new Error(second.code)
    expect(second.removed).toBe(2)

    const back = await ladderFor(fx.db, {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece',
    })
    expect(rungsToRows(back)).toEqual([{ minQty: '1', rate: '11' }])
  })

  it('clears out when the box is emptied', async () => {
    const p = await makeProduct(fx.db)
    await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10'),
    })
    await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: [],
    })
    expect(await ladderFor(fx.db, {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece',
    })).toEqual([])
  })

  it('can be written against a bigger unit too', async () => {
    const p = await makeProduct(fx.db)
    await setUnits(fx.db, ctx(), p, [{ saleUnit: 'box', baseUnits: fromUnits(24) }])
    const saved = await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'box', rungs: rungs('1=200, 5=190'),
    })
    expect(saved.ok).toBe(true)
  })

  it('is refused against a unit the item does not sell in', async () => {
    const p = await makeProduct(fx.db)
    const saved = await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'ream', rungs: rungs('1=300'),
    })
    expect(saved.ok).toBe(false)
  })

  it('comes back for a whole screen of products in one read', async () => {
    const a = await makeProduct(fx.db, { name: 'A' })
    const b = await makeProduct(fx.db, { name: 'B' })
    await makeProduct(fx.db, { name: 'No ladder' })
    await setLadder(fx.db, ctx(), {
      productId: a, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10, 10=9'),
    })
    await setLadder(fx.db, ctx(), {
      productId: b, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=5'),
    })

    const all = await laddersFor(fx.db, fx.seed.priceListId)
    expect(all.size).toBe(2)
    expect(describeLadder(all.get(a)!)).toBe('1=₹10 · 10=₹9')
    expect(describeLadder(all.get(b)!)).toBe('1=₹5')
  })
})

describe('a ladder for one customer and one item', () => {
  it('beats the price list at every rung', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(12) })
    const customer = await makeCustomer(fx.db, 'Ramesh Stores')

    await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10, 10=9'),
    })
    await setCustomerLadder(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rungs: rungs('1=9, 10=8, 50=7'),
    })

    const candidates = await loadPriceCandidates(fx.db, {
      productId: p, saleUnit: 'piece', defaultPriceListId: fx.seed.priceListId,
      customerId: customer, customerPriceListId: null,
    })

    for (const [units, rate] of [[1, rupees(9)], [10, rupees(8)], [80, rupees(7)]] as const) {
      const resolved = resolvePrice(candidates, fromUnits(units))
      expect(resolved.rate).toBe(rate)
      expect(resolved.source).toBe('customer_override')
    }
  })

  /* Below their lowest rung the customer has said nothing, so the shop's own
     ladder answers — not their best rate, and not the base rate either. */
  it('falls back to the list below its lowest rung', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(12) })
    const customer = await makeCustomer(fx.db)

    await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10'),
    })
    await setCustomerLadder(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rungs: rungs('10=8'),
    })

    const candidates = await loadPriceCandidates(fx.db, {
      productId: p, saleUnit: 'piece', defaultPriceListId: fx.seed.priceListId,
      customerId: customer, customerPriceListId: null,
    })

    const one = resolvePrice(candidates, fromUnits(1))
    expect(one.rate).toBe(rupees(10))
    expect(one.source).toBe('default_list')
    expect(resolvePrice(candidates, fromUnits(10)).rate).toBe(rupees(8))
  })

  it('reads back for the customer it belongs to', async () => {
    const p = await makeProduct(fx.db)
    const customer = await makeCustomer(fx.db)
    await setCustomerLadder(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rungs: rungs('1=9, 10=8'),
    })

    const back = await customerLadderFor(fx.db, { customerId: customer, productId: p, saleUnit: 'piece' })
    expect(rungsToRows(back)).toEqual([{ minQty: '1', rate: '9' }, { minQty: '10', rate: '8' }])
  })

  it('replaces the whole of it, like the list one', async () => {
    const p = await makeProduct(fx.db)
    const customer = await makeCustomer(fx.db)
    await setCustomerLadder(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rungs: rungs('1=9, 10=8, 50=7'),
    })
    await setCustomerLadder(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rungs: rungs('1=9'),
    })

    const back = await customerLadderFor(fx.db, { customerId: customer, productId: p, saleUnit: 'piece' })
    expect(rungsToRows(back)).toEqual([{ minQty: '1', rate: '9' }])
  })

  it('belongs to that customer alone', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(12) })
    const mine = await makeCustomer(fx.db, 'Ramesh Stores')
    const other = await makeCustomer(fx.db, 'Somebody else')
    await setCustomerLadder(fx.db, ctx(), {
      customerId: mine, productId: p, saleUnit: 'piece', rungs: rungs('1=7'),
    })

    const theirs = await loadPriceCandidates(fx.db, {
      productId: p, saleUnit: 'piece', defaultPriceListId: fx.seed.priceListId,
      customerId: other, customerPriceListId: null,
    })
    expect(resolvePrice(theirs, fromUnits(1)).source).toBe('base_rate')
  })
})
