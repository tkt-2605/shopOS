import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolvePrice } from '../src/domain/pricing.js'
import {
  createPriceList, setItemPrice, setLadder, setCustomerLadder, setCustomerPriceList, listItemPrices,
  customersOnList, itemsPricedTwice, settleDoublePrice, pricesElsewhere,
  exportLadders, planLadderImport, applyLadderImport,
} from '../src/services/pricing.js'
import { defaultPriceListId } from '../src/repos/pricing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, qty } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Special Prices made plain (24 October): one normal price per item, the
 * default list holding only its quantity breaks, and every special price in
 * and out of a spreadsheet.
 */

let fx: Fixture
let pen: string
let everyone: string
const ctx = () => ({ actorId: fx.adminId })

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'Ball Pen Black', baseRate: rupees(10), taxRateBp: 0, barcode: '8901' })
  everyone = (await defaultPriceListId(fx.db))!
})
afterEach(async () => { await fx.db.close() })

async function list(name: string): Promise<string> {
  const made = await createPriceList(fx.db, ctx(), { name })
  if (!made.ok) throw new Error(made.code)
  return made.priceListId
}

describe('the item\'s own quantity breaks', () => {
  const tier = (minUnits: number, rate: number) => ({ id: `t${minUnits}`, minQty: fromUnits(minUnits), rate: rupees(rate) })

  it('charge from their quantity up, and the selling rate below it', () => {
    const c = { baseRate: rupees(10), defaultListTiers: [tier(10, 9)] }
    expect(resolvePrice(c, fromUnits(1)).rate).toBe(rupees(10))
    expect(resolvePrice(c, fromUnits(10)).rate).toBe(rupees(9))
  })

  it('with breaks turned off, never make a break the price of one', () => {
    const c = { baseRate: rupees(10), defaultListTiers: [tier(10, 9)], quantityBreaks: false }
    expect(resolvePrice(c, fromUnits(1)).rate).toBe(rupees(10))
    expect(resolvePrice(c, fromUnits(50)).rate).toBe(rupees(10))
  })

  it('with breaks off, still honour a rate that starts at one', () => {
    const c = { baseRate: rupees(10), defaultListTiers: [{ ...tier(0, 9), minQty: qty(0) }], quantityBreaks: false }
    expect(resolvePrice(c, fromUnits(1)).rate).toBe(rupees(9))
  })
})

describe('an item priced twice', () => {
  it('is found when the shop list gives it a plain rate, and says whether the two agree', async () => {
    const same = await makeProduct(fx.db, { name: 'Eraser', baseRate: rupees(5), taxRateBp: 0 })
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rate: rupees(9) })
    await setItemPrice(fx.db, ctx(), { productId: same, priceListId: everyone, saleUnit: 'piece', rate: rupees(5) })
    // A break at ten is not a second price for one.
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', minQty: fromUnits(10), rate: rupees(8) })

    const found = await itemsPricedTwice(fx.db)
    expect(found.map((d) => [d.name, d.sellingRate, d.listRate, d.same])).toEqual([
      ['Ball Pen Black', rupees(10), rupees(9), false],
      ['Eraser', rupees(5), rupees(5), true],
    ])
  })

  it('keeping the selling rate takes the list rate off and leaves the breaks', async () => {
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rate: rupees(9) })
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', minQty: fromUnits(10), rate: rupees(8) })

    expect(await settleDoublePrice(fx.db, ctx(), { productId: pen, keep: 'selling' })).toEqual({ ok: true })
    expect(await itemsPricedTwice(fx.db)).toEqual([])
    const left = await listItemPrices(fx.db, { productId: pen })
    expect(left.map((r) => r.minQty)).toEqual([fromUnits(10)])
    const row = await fx.db.get<{ base_rate: number }>('SELECT base_rate FROM products WHERE id = ?', [pen])
    expect(row!.base_rate).toBe(rupees(10))
  })

  it('keeping the list rate makes it the selling rate, so nothing a customer pays changes', async () => {
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rate: rupees(9) })
    await settleDoublePrice(fx.db, ctx(), { productId: pen, keep: 'list' })
    const row = await fx.db.get<{ base_rate: number }>('SELECT base_rate FROM products WHERE id = ?', [pen])
    expect(row!.base_rate).toBe(rupees(9))
    expect(await itemsPricedTwice(fx.db)).toEqual([])
  })
})

describe('where else an item is priced', () => {
  it('lists other price lists and customers, and not the item\'s own breaks', async () => {
    const wholesale = await list('Wholesale')
    const school = await makeCustomer(fx.db, 'Sri Vidya School')
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: wholesale, saleUnit: 'piece', rate: rupees(8.5) })
    await setLadder(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rungs: [{ minQty: fromUnits(10), rate: rupees(9) }] })
    await setCustomerLadder(fx.db, ctx(), { customerId: school, productId: pen, saleUnit: 'piece', rungs: [{ minQty: qty(0), rate: rupees(7.5) }] })

    const found = await pricesElsewhere(fx.db, pen)
    expect(found.map((p) => [p.kind, p.who, p.rate])).toEqual([
      ['list', 'Wholesale', rupees(8.5)],
      ['customer', 'Sri Vidya School', rupees(7.5)],
    ])
  })

  it('names the customers on a list', async () => {
    const wholesale = await list('Wholesale')
    const school = await makeCustomer(fx.db, 'Sri Vidya School')
    await makeCustomer(fx.db, 'Walk-in Ravi')
    await setCustomerPriceList(fx.db, ctx(), school, wholesale)
    expect(await customersOnList(fx.db, wholesale)).toEqual([{ id: school, name: 'Sri Vidya School' }])
  })
})

describe('special prices in a spreadsheet', () => {
  const file = (...rows: string[]) => ['item,barcode,unit,price_list,customer,min_qty,rate,from,to', ...rows].join('\n')

  it('plans a file without writing anything, and says what each ladder will become', async () => {
    const wholesale = await list('Wholesale')
    await makeCustomer(fx.db, 'Sri Vidya School')
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: wholesale, saleUnit: 'piece', rate: rupees(8.5) })

    const plan = await planLadderImport(fx.db, file(
      'Ball Pen Black,,,Wholesale,,1,8.00,,',
      'Ball Pen Black,,,Wholesale,,10,7.50,,',
      ',8901,,,Sri Vidya School,,7.25,,',
      'Ball Pen Black,,,,,12,9.00,,',
    ))
    expect(plan.problems).toEqual([])
    expect(plan.ladders.map((l) => [l.target.kind, l.change, l.rungs.length])).toEqual([
      ['list', 'change', 2], ['customer', 'new', 1], ['everyone', 'new', 1],
    ])
    expect((await listItemPrices(fx.db, { priceListId: wholesale }))[0]!.rate).toBe(rupees(8.5))
  })

  it('writes the plan, replacing each ladder it names', async () => {
    const wholesale = await list('Wholesale')
    await setLadder(fx.db, ctx(), { productId: pen, priceListId: wholesale, saleUnit: 'piece',
      rungs: [{ minQty: fromUnits(1), rate: rupees(9) }, { minQty: fromUnits(50), rate: rupees(7) }] })

    const plan = await planLadderImport(fx.db, file('Ball Pen Black,,,Wholesale,,1,8.50,,', 'Ball Pen Black,,,Wholesale,,10,8.00,,'))
    const done = await applyLadderImport(fx.db, ctx(), plan.ladders)
    expect(done).toMatchObject({ written: 1, cleared: 0, belowCost: [], failed: [] })
    const rows = await listItemPrices(fx.db, { priceListId: wholesale })
    expect(rows.map((r) => [r.minQty, r.rate])).toEqual([[fromUnits(1), rupees(8.5)], [fromUnits(10), rupees(8)]])
  })

  it('takes a ladder off with one row and a blank rate, and leaves unmentioned ladders alone', async () => {
    const wholesale = await list('Wholesale')
    const eraser = await makeProduct(fx.db, { name: 'Eraser', baseRate: rupees(5), taxRateBp: 0 })
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: wholesale, saleUnit: 'piece', rate: rupees(8.5) })
    await setItemPrice(fx.db, ctx(), { productId: eraser, priceListId: wholesale, saleUnit: 'piece', rate: rupees(4) })

    const plan = await planLadderImport(fx.db, file('Ball Pen Black,,,Wholesale,,,,,'))
    expect(plan.ladders[0]!.change).toBe('clear')
    expect(await applyLadderImport(fx.db, ctx(), plan.ladders)).toMatchObject({ cleared: 1 })
    expect((await listItemPrices(fx.db, { priceListId: wholesale })).map((r) => r.productName)).toEqual(['Eraser'])
  })

  it('names every row it cannot take, and skips the rest of that ladder with it', async () => {
    await list('Wholesale')
    const plan = await planLadderImport(fx.db, file(
      'Ball Pen Black,,,Wholsale,,1,8,,',
      'Stapler,,,Wholesale,,1,8,,',
      'Ball Pen Black,,,Wholesale,,1,8,,',
      'Ball Pen Black,,,Wholesale,,1,7,,',
      'Ball Pen Black,,,,,1,9,,',
      'Ball Pen Black,,,Wholesale,Sri Vidya School,1,9,,',
    ))
    expect(plan.problems.map((p) => [p.line, p.problem])).toEqual([
      [2, 'UNKNOWN_LIST'], [3, 'UNKNOWN_ITEM'], [4, 'LADDER_SKIPPED'], [5, 'REPEATED_QTY'],
      [6, 'EVERYONE_NEEDS_QTY'], [7, 'LIST_AND_CUSTOMER'],
    ])
    expect(plan.ladders).toEqual([])
  })

  it('hands back a ladder below cost rather than writing it, and writes it when allowed', async () => {
    await fx.db.execute('UPDATE products SET cost_price = ? WHERE id = ?', [rupees(9), pen])
    await list('Wholesale')
    const plan = await planLadderImport(fx.db, file('Ball Pen Black,,,Wholesale,,1,8,,'))
    const first = await applyLadderImport(fx.db, ctx(), plan.ladders)
    expect(first.written).toBe(0)
    expect(first.belowCost).toHaveLength(1)
    const again = await applyLadderImport(fx.db, ctx(), first.belowCost.map((b) => b.ladder), { allowBelowCost: true })
    expect(again.written).toBe(1)
  })

  it('round-trips: what it exports, it reads back as nothing to change', async () => {
    const wholesale = await list('Wholesale')
    const school = await makeCustomer(fx.db, 'Sri Vidya School')
    await setLadder(fx.db, ctx(), { productId: pen, priceListId: wholesale, saleUnit: 'piece', validTo: '2026-12-31',
      rungs: [{ minQty: fromUnits(1), rate: rupees(8.5) }, { minQty: fromUnits(10), rate: rupees(8) }] })
    await setLadder(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rungs: [{ minQty: fromUnits(12), rate: rupees(9) }] })
    await setCustomerLadder(fx.db, ctx(), { customerId: school, productId: pen, saleUnit: 'piece', rungs: [{ minQty: qty(0), rate: rupees(7.5) as Money }] })

    const csv = await exportLadders(fx.db)
    expect(csv.split('\r\n')[0]).toBe('item,barcode,unit,price_list,customer,min_qty,rate,from,to')
    const plan = await planLadderImport(fx.db, csv)
    expect(plan.problems).toEqual([])
    expect(plan.ladders.map((l) => l.change)).toEqual(['same', 'same', 'same'])
  })

  it('reads a date as Excel in India rewrites it', async () => {
    const wholesale = await list('Wholesale')
    const plan = await planLadderImport(fx.db, file('Ball Pen Black,,,Wholesale,,1,8,01/11/2026,31-12-2026'))
    expect(plan.ladders[0]).toMatchObject({ validFrom: '2026-11-01', validTo: '2026-12-31' })
    await applyLadderImport(fx.db, ctx(), plan.ladders)
    expect((await listItemPrices(fx.db, { priceListId: wholesale }))[0]).toMatchObject({ validTo: '2026-12-31' })
  })
})
