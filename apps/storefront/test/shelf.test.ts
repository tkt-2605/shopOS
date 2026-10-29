import { describe, it, expect } from 'vitest'
import type { Catalog, CatalogItem } from '../src/api'
import { againFrom, brandsIn, changesIn, checkCart, matchScore, nextTier, NO_FILTERS, priceAt, repriced, saving, shelf } from '../src/shelf'

/** Searching, sorting and filtering the catalogue on the phone, and holding a cart up against it. */

const item = (id: string, name: string, price: number, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  id, name, brand: null, categoryId: 'pens', units: [{ unit: 'piece', price, mrp: null }],
  available: true, thumb: null, photo: null, ...extra,
})

const catalog: Catalog = {
  shop: 'TRT',
  categories: [{ id: 'pens', name: 'Pens', parentId: null }, { id: 'paper', name: 'Paper', parentId: null }],
  items: [
    item('a', 'Ball Pen Blue', 1000, { brand: 'Cello', units: [{ unit: 'piece', price: 1000, mrp: 1200 }] }),
    item('b', 'Gel Pen 0.5mm', 2500, { brand: 'Reynolds' }),
    item('c', 'A4 Copier Paper', 34000, { brand: 'JK', categoryId: 'paper', available: false }),
    item('d', 'Notebook', 6000, { categoryId: 'paper' }),
  ],
}

describe('searching', () => {
  it('finds by the start of a word, by brand, by group, and through one typo', () => {
    expect(matchScore(catalog.items[0]!, 'ball')).toBeGreaterThan(0)
    expect(matchScore(catalog.items[0]!, 'cello')).toBeGreaterThan(0)
    expect(matchScore(catalog.items[3]!, 'paper', 'Paper')).toBeGreaterThan(0)
    expect(matchScore(catalog.items[3]!, 'notbook')).toBeGreaterThan(0)
    expect(matchScore(catalog.items[0]!, 'stapler')).toBe(0)
  })

  it('puts a name match above a brand match', () => {
    expect(shelf(catalog, { ...NO_FILTERS, query: 'pen' }).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('sorting and filtering', () => {
  it('sorts by price both ways and by the biggest saving', () => {
    expect(shelf(catalog, { ...NO_FILTERS, sort: 'low' }).map((i) => i.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(shelf(catalog, { ...NO_FILTERS, sort: 'high' }).map((i) => i.id)[0]).toBe('c')
    expect(shelf(catalog, { ...NO_FILTERS, sort: 'saving' }).map((i) => i.id)[0]).toBe('a')
  })

  it('filters to a group (in stock first), a brand, offers and what is in stock', () => {
    expect(shelf(catalog, { ...NO_FILTERS, groupIds: new Set(['paper']) }).map((i) => i.id)).toEqual(['d', 'c'])
    expect(shelf(catalog, { ...NO_FILTERS, brands: new Set(['Reynolds']) }).map((i) => i.id)).toEqual(['b'])
    expect(shelf(catalog, { ...NO_FILTERS, offersOnly: true }).map((i) => i.id)).toEqual(['a'])
    expect(shelf(catalog, { ...NO_FILTERS, inStockOnly: true }).map((i) => i.id)).not.toContain('c')
    expect(brandsIn(catalog.items)).toEqual(['Cello', 'JK', 'Reynolds'])
  })

  it('works out the saving against MRP, and none without one', () => {
    expect(saving({ unit: 'piece', price: 1000, mrp: 1200 })).toEqual({ amount: 200, percent: 17 })
    expect(saving({ unit: 'piece', price: 1000, mrp: null })).toBeNull()
    expect(saving({ unit: 'piece', price: 1000, mrp: 900 })).toBeNull()
  })
})

describe('what the shop changed', () => {
  it('reads each line as fewer, more, taken off, added or the same', () => {
    const line = (productId: string, qty: number, seenPrice = 1000) => ({ productId, name: productId, unit: 'piece', qty, seenPrice })
    expect(changesIn([line('a', 5), line('b', 1), line('c', 2), line('d', 1)], [line('a', 3), line('c', 4), line('d', 1), line('e', 2, 900)])
      .map((c) => [c.name, c.kind, c.from, c.to])).toEqual([
      ['a', 'fewer', 5, 3], ['b', 'removed', 1, 0], ['c', 'more', 2, 4], ['d', 'same', 1, 1], ['e', 'added', 0, 2],
    ])
  })
})

describe('quantity prices', () => {
  const unit = { unit: 'piece', price: 1000, mrp: null, tiers: [{ minQty: 10, price: 900 }, { minQty: 50, price: 800 }] }

  it('charges the lowest rung reached', () => {
    expect([1, 9, 10, 49, 50, 200].map((q) => priceAt(unit, q))).toEqual([1000, 1000, 900, 900, 800, 800])
    expect(priceAt({ unit: 'piece', price: 1000, mrp: null }, 100)).toBe(1000)
  })

  it('says how many more reach the next rung, and what that many save', () => {
    expect(nextTier(unit, 7)).toEqual({ minQty: 10, price: 900, more: 3, save: 1000 })
    expect(nextTier(unit, 10)).toMatchObject({ minQty: 50, more: 40, save: 10000 })
    expect(nextTier(unit, 50)).toBeNull()
  })

  it('prices a cart line at its quantity, and orders it at that price', () => {
    const tiered: Catalog = { ...catalog, items: [item('t', 'Pencil', 1000, { units: [unit] })] }
    const lines = checkCart([{ productId: 't', name: 'Pencil', unit: 'piece', qty: 12, price: 1000 }], tiered)
    expect(lines[0]).toMatchObject({ each: 900, now: { price: 1000 } })
    expect(repriced(lines)[0]?.price).toBe(900)
  })
})

describe('the cart against today’s catalogue', () => {
  it('takes today’s price, and leaves out what is no longer sold', () => {
    const cart = [
      { productId: 'b', name: 'Gel Pen', unit: 'piece', qty: 2, price: 2000 },
      { productId: 'gone', name: 'Old item', unit: 'piece', qty: 1, price: 500 },
    ]
    const lines = checkCart(cart, catalog)
    expect(lines.map((l) => l.now?.price ?? null)).toEqual([2500, null])
    expect(repriced(lines)).toEqual([{ productId: 'b', name: 'Gel Pen', unit: 'piece', qty: 2, price: 2500 }])
  })

  it('orders again what is still sold, at today’s price and with its brand', () => {
    expect(againFrom([{ productId: 'a', unit: 'piece', qty: 3 }, { productId: 'gone', unit: 'piece', qty: 1 }], catalog))
      .toEqual([{ productId: 'a', name: 'Ball Pen Blue (Cello)', unit: 'piece', qty: 3, price: 1000 }])
  })
})
