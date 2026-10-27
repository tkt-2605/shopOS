import { describe, it, expect } from 'vitest'
import type { Catalog, CatalogItem } from '../src/api'
import { againFrom, brandsIn, checkCart, matchScore, NO_FILTERS, repriced, saving, shelf } from '../src/shelf'

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
