import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  parseLadder, formatLadder, describeLadder, rateFor, risingRungs,
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

function rungs(text: string) {
  const parsed = parseLadder(text)
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.rungs
}

describe('writing a ladder the way a shopkeeper says it', () => {
  it('reads one is ten, ten is nine, fifty is eight', () => {
    const parsed = parseLadder('1=10, 10=9, 50=8')
    if (!parsed.ok) throw new Error(parsed.code)

    expect(parsed.rungs.map((r) => [toUnits(r.minQty), r.rate]))
      .toEqual([[1, rupees(10)], [10, rupees(9)], [50, rupees(8)]])
  })

  it('does not mind how it is written', () => {
    const forms = [
      '1=10, 10=9, 50=8',
      '1 = 10 , 10 = 9 , 50 = 8',
      '1@10; 10@9; 50@8',
      '1:₹10\n10:Rs 9\n50: rs.8',
    ]
    for (const form of forms) {
      const parsed = parseLadder(form)
      if (!parsed.ok) throw new Error(`${form}: ${parsed.code}`)
      expect(parsed.rungs.map((r) => r.rate)).toEqual([rupees(10), rupees(9), rupees(8)])
    }
  })

  it('puts the rungs in the order they apply, however they were typed', () => {
    expect(formatLadder(rungs('50=8, 1=10, 10=9'))).toBe('1=10, 10=9, 50=8')
  })

  /* The comma separates one rung from the next, so a grouped ₹1,200 would read
     as two rungs. */
  it('survives a four-figure rate going out and coming back', () => {
    const text = formatLadder(rungs('1=1200, 10=1150.50'))
    expect(text).toBe('1=1200, 10=1150.50')
    const again = parseLadder(text)
    if (!again.ok) throw new Error(again.code)
    expect(again.rungs.map((r) => r.rate)).toEqual([rupees(1200), 115050])
  })

  it('takes paise', () => {
    const parsed = parseLadder('1=10.50, 12=9.75')
    if (!parsed.ok) throw new Error(parsed.code)
    expect(parsed.rungs.map((r) => r.rate)).toEqual([1050, 975])
  })

  it('takes a fractional quantity, for things sold by weight', () => {
    const parsed = parseLadder('0.5=30, 1=55')
    if (!parsed.ok) throw new Error(parsed.code)
    expect(toUnits(parsed.rungs[0]!.minQty)).toBe(0.5)
  })

  /* A ladder quietly missing its top rung sells at the wrong price all week. */
  it('refuses what it cannot read rather than dropping it', () => {
    expect(parseLadder('1=10, rubbish, 50=8').ok).toBe(false)
    expect(parseLadder('1=10, ten=9').ok).toBe(false)
    expect(parseLadder('1=10, 10=nine').ok).toBe(false)
  })

  it('refuses the same quantity twice, which has no answer', () => {
    const result = parseLadder('10=9, 10=8')
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('REPEATED_QTY')
  })

  it('reads an empty box as no ladder at all', () => {
    const parsed = parseLadder('   ')
    if (!parsed.ok) throw new Error(parsed.code)
    expect(parsed.rungs).toEqual([])
  })

  it('writes itself out for a column', () => {
    expect(describeLadder(rungs('1=10, 10=9'))).toBe('1=₹10 · 10=₹9')
  })
})

describe('what a ladder charges', () => {
  it('uses the highest rung the quantity reaches, inclusive at the break', () => {
    const ladder = rungs('1=10, 10=9, 50=8')
    expect(rateFor(ladder, fromUnits(1))).toBe(rupees(10))
    expect(rateFor(ladder, fromUnits(9))).toBe(rupees(10))
    expect(rateFor(ladder, fromUnits(10))).toBe(rupees(9))
    expect(rateFor(ladder, fromUnits(49))).toBe(rupees(9))
    expect(rateFor(ladder, fromUnits(50))).toBe(rupees(8))
    expect(rateFor(ladder, fromUnits(500))).toBe(rupees(8))
  })

  it('has no answer below the lowest rung, which is the base rate\'s job', () => {
    expect(rateFor(rungs('10=9'), fromUnits(1))).toBeNull()
  })

  /* Almost always a typo — 10=90 rather than 10=9 — but a shop may genuinely
     price a loose unit below a sealed box, so it is said rather than refused. */
  it('points out a rung that charges more for buying more', () => {
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
    expect(formatLadder(back)).toBe('1=10, 10=9')
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
    expect(formatLadder(back)).toBe('1=11')
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
    expect(formatLadder(back)).toBe('1=9, 10=8')
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
    expect(formatLadder(back)).toBe('1=9')
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
