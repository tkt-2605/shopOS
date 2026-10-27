import type { Catalog, CatalogItem, CatalogUnit } from './api'
import { shownName, type CartLine } from './money'

/*
 * Everything the storefront works out from the catalogue it already holds:
 * searching, sorting, filtering, offers, and whether the cart still matches
 * what the shop sells. All of it on the phone -- none of it asks the shop
 * anything -- so a busy evening of browsing costs the main till nothing.
 */

// ---------------------------------------------------------------- search

/** Two words match if one starts the other, or they are a letter apart (a typo). */
function close(word: string, query: string): boolean {
  if (word.startsWith(query) || word.includes(query)) return true
  if (query.length < 4 || Math.abs(word.length - query.length) > 1) return false
  let a = 0
  let b = 0
  let edits = 0
  while (a < word.length && b < query.length) {
    if (word[a] === query[b]) { a++; b++; continue }
    if (++edits > 1) return false
    if (word.length > query.length) a++
    else if (word.length < query.length) b++
    else { a++; b++ }
  }
  return edits + (word.length - a) + (query.length - b) <= 1
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)

/** How well an item matches what was typed: 0 is no match, higher is better. */
export function matchScore(item: CatalogItem, query: string, groupName = ''): number {
  const asked = words(query)
  if (asked.length === 0) return 1
  const name = words(item.name)
  const extra = [...words(item.brand ?? ''), ...words(groupName)]
  let score = 0
  for (const q of asked) {
    if (name.some((w) => w.startsWith(q))) score += 3
    else if (name.some((w) => close(w, q))) score += 2
    else if (extra.some((w) => close(w, q))) score += 1
    else return 0
  }
  return score
}

// ---------------------------------------------------------------- prices

/** The cheapest unit, which is the price shown on a tile. */
export const firstUnit = (item: CatalogItem): CatalogUnit => item.units[0]!

/** What a customer saves against the MRP printed on one of the unit, or null when nothing. */
export function saving(unit: CatalogUnit): { amount: number; percent: number } | null {
  if (unit.mrp === null || unit.mrp <= unit.price) return null
  const amount = unit.mrp - unit.price
  return { amount, percent: Math.round((amount / unit.mrp) * 100) }
}

export const onOffer = (item: CatalogItem) => item.units.some((u) => saving(u) !== null)

// ---------------------------------------------------------------- sort and filter

export type SortBy = 'best' | 'name' | 'low' | 'high' | 'saving'

export interface Filters {
  query: string
  groupIds: ReadonlySet<string> | null
  brands: ReadonlySet<string>
  offersOnly: boolean
  inStockOnly: boolean
  sort: SortBy
}

export const NO_FILTERS: Filters = {
  query: '', groupIds: null, brands: new Set(), offersOnly: false, inStockOnly: false, sort: 'best',
}

/** The group and every group under it. */
export function groupAndBelow(catalog: Catalog, id: string): Set<string> {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const c of catalog.categories) {
      if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); grew = true }
    }
  }
  return ids
}

export function shelf(catalog: Catalog, f: Filters): CatalogItem[] {
  const groupName = new Map(catalog.categories.map((c) => [c.id, c.name]))
  const scored = catalog.items
    .filter((i) => f.groupIds === null || (i.categoryId !== null && f.groupIds.has(i.categoryId)))
    .filter((i) => f.brands.size === 0 || (i.brand !== null && f.brands.has(i.brand)))
    .filter((i) => !f.offersOnly || onOffer(i))
    .filter((i) => !f.inStockOnly || i.available)
    .map((i) => ({ i, s: matchScore(i, f.query, groupName.get(i.categoryId ?? '') ?? '') }))
    .filter(({ s }) => s > 0)
  const price = (i: CatalogItem) => firstUnit(i).price
  const pct = (i: CatalogItem) => Math.max(0, ...i.units.map((u) => saving(u)?.percent ?? 0))
  const byName = (a: CatalogItem, b: CatalogItem) => shownName(a).localeCompare(shownName(b))
  const sorters: Record<SortBy, (a: { i: CatalogItem; s: number }, b: { i: CatalogItem; s: number }) => number> = {
    best: (a, b) => b.s - a.s || Number(b.i.available) - Number(a.i.available) || byName(a.i, b.i),
    name: (a, b) => byName(a.i, b.i),
    low: (a, b) => price(a.i) - price(b.i) || byName(a.i, b.i),
    high: (a, b) => price(b.i) - price(a.i) || byName(a.i, b.i),
    saving: (a, b) => pct(b.i) - pct(a.i) || byName(a.i, b.i),
  }
  return scored.sort(sorters[f.sort]).map(({ i }) => i)
}

/** Brands present among these items, most items first. */
export function brandsIn(items: readonly CatalogItem[]): string[] {
  const n = new Map<string, number>()
  for (const i of items) if (i.brand) n.set(i.brand, (n.get(i.brand) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b)
}

// ---------------------------------------------------------------- cart against the catalogue

export interface CheckedLine extends CartLine {
  /** The unit as the catalogue has it now, or null when it is no longer sold online. */
  now: CatalogUnit | null
  item: CatalogItem | null
}

/** Each cart line beside today's catalogue: its current price, or that it has gone. */
export function checkCart(cart: readonly CartLine[], catalog: Catalog | undefined): CheckedLine[] {
  const byId = new Map((catalog?.items ?? []).map((i) => [i.id, i]))
  return cart.map((l) => {
    const item = byId.get(l.productId) ?? null
    const now = item?.units.find((u) => u.unit === l.unit) ?? null
    return { ...l, item, now: catalog ? now : { unit: l.unit, price: l.price, mrp: null } }
  })
}

/** The cart at today's prices, without lines the shop no longer sells. */
export function repriced(lines: readonly CheckedLine[]): CartLine[] {
  return lines.filter((l) => l.now !== null).map(({ productId, name, unit, qty, now }) => ({
    productId, name, unit, qty, price: now!.price,
  }))
}

/** A past order's lines that can go back in the cart, at today's prices. */
export function againFrom(lines: readonly { productId: string; unit: string; qty: number }[], catalog: Catalog): CartLine[] {
  const byId = new Map(catalog.items.map((i) => [i.id, i]))
  return lines.flatMap((l) => {
    const item = byId.get(l.productId)
    const unit = item?.units.find((u) => u.unit === l.unit)
    return item && unit ? [{ productId: item.id, name: shownName(item), unit: unit.unit, qty: l.qty, price: unit.price }] : []
  })
}
