import { eq, and, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { parseCsvRecords, toCsv } from '../../domain/csv.js'
import { parseMoney, type Money } from '../../money.js'
import { parseQty, formatQty, QTY_SCALE, type Qty } from '../../quantity.js'
import type { Rung } from '../../domain/ladder.js'
import type { AuditContext } from '../../integrity/audit.js'
import { defaultPriceListId } from '../../repos/pricing.js'
import type { BelowCostRefusal } from '../belowCost.js'
import { setCustomerLadder, setLadder } from './ladders.js'
import { isOn } from '../features.js'
import { formerBaseUnit } from '../../repos/pricing.js'

/*
 * Special prices in and out of a spreadsheet: one row per rung.
 *
 *   item, barcode, unit, price_list, customer, min_qty, rate, from, to
 *
 * A row names a price list or a customer. Naming neither is the item's own
 * quantity breaks, which every customer earns above its selling rate. An item
 * on a list (or for a customer) in a unit is one ladder, and the file's rows
 * for it *are* that ladder: a rung the file leaves out is taken off. A ladder
 * the file does not mention is left alone, so a file of twenty items does not
 * wipe the other five hundred. One row with a blank rate takes the ladder off.
 *
 * As with the catalogue, choosing a file writes nothing: `planLadderImport`
 * says what would happen, and `applyLadderImport` does it.
 */

export const LADDER_COLUMNS = ['item', 'barcode', 'unit', 'price_list', 'customer', 'min_qty', 'rate', 'from', 'to'] as const

export type LadderProblem =
  | 'NO_ITEM' | 'UNKNOWN_ITEM' | 'ITEM_AMBIGUOUS'
  | 'UNKNOWN_LIST' | 'UNKNOWN_CUSTOMER' | 'CUSTOMER_AMBIGUOUS' | 'LIST_AND_CUSTOMER'
  | 'BAD_QTY' | 'BAD_RATE' | 'BAD_DATE' | 'DATES_DIFFER' | 'REPEATED_QTY'
  /** For everyone, the price of one is the item's selling rate: a break needs a quantity above one. */
  | 'EVERYONE_NEEDS_QTY'
  /**
   * A box priced for everyone while "Box prices and MRP" is off (079). It
   * would be saved and not charged, which is the hidden price the switch is
   * there to prevent; the row says to turn it on first.
   */
  | 'UNIT_PRICES_OFF'
  /** Another row of the same ladder is wrong, so none of it is touched. */
  | 'LADDER_SKIPPED'

export interface LadderRowProblem {
  line: number
  item: string
  problem: LadderProblem
}

export type LadderTarget =
  | { kind: 'everyone' }
  | { kind: 'list'; priceListId: string; name: string }
  | { kind: 'customer'; customerId: string; name: string }

export interface PlannedLadder {
  key: string
  target: LadderTarget
  productId: string
  productName: string
  saleUnit: string
  rungs: Rung[]
  validFrom: string | null
  validTo: string | null
  change: 'new' | 'change' | 'same' | 'clear'
  lines: number[]
}

export interface LadderPlan {
  ladders: PlannedLadder[]
  problems: LadderRowProblem[]
  unknownColumns: string[]
  rows: number
}

const norm = (s: string) => s.trim().toLowerCase()
const header = (c: string) => c.replace(/_/g, '')

/* --------------------------------------------------------------- export --- */

export async function exportLadders(db: SqlDriver): Promise<string> {
  const everyone = await defaultPriceListId(db)
  const lists = await q(db)
    .select({
      item: schema.products.name, barcode: schema.products.barcode, unit: schema.itemPrices.saleUnit,
      listId: schema.priceLists.id, list: schema.priceLists.name,
      minQty: schema.itemPrices.minQty, rate: schema.itemPrices.rate,
      from: schema.itemPrices.validFrom, to: schema.itemPrices.validTo,
    })
    .from(schema.itemPrices)
    .innerJoin(schema.products, eq(schema.products.id, schema.itemPrices.productId))
    .innerJoin(schema.priceLists, eq(schema.priceLists.id, schema.itemPrices.priceListId))
    .where(and(isNull(schema.itemPrices.deletedAt), isNull(schema.products.deletedAt), isNull(schema.priceLists.deletedAt)))
    .orderBy(schema.priceLists.name, schema.products.name, schema.itemPrices.saleUnit, schema.itemPrices.minQty)
  const customers = await q(db)
    .select({
      item: schema.products.name, barcode: schema.products.barcode, unit: schema.customerItemPrices.saleUnit,
      customer: schema.customers.name, minQty: schema.customerItemPrices.minQty, rate: schema.customerItemPrices.rate,
      from: schema.customerItemPrices.validFrom, to: schema.customerItemPrices.validTo,
    })
    .from(schema.customerItemPrices)
    .innerJoin(schema.products, eq(schema.products.id, schema.customerItemPrices.productId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.customerItemPrices.customerId))
    .where(and(isNull(schema.customerItemPrices.deletedAt), isNull(schema.products.deletedAt), isNull(schema.customers.deletedAt)))
    .orderBy(schema.customers.name, schema.products.name, schema.customerItemPrices.saleUnit, schema.customerItemPrices.minQty)

  const rupees = (m: Money) => (m / 100).toFixed(2)
  const rows: (string | number)[][] = [
    // Everyone's breaks first: the item's own, then the lists, then single customers.
    ...[...lists].sort((a, b) => Number(b.listId === everyone) - Number(a.listId === everyone)).map((r) => [
      r.item, r.barcode ?? '', r.unit, r.listId === everyone ? '' : r.list, '',
      formatQty(r.minQty as Qty), rupees(r.rate), r.from ?? '', r.to ?? '',
    ]),
    ...customers.map((r) => [
      r.item, r.barcode ?? '', r.unit, '', r.customer, formatQty(r.minQty as Qty), rupees(r.rate), r.from ?? '', r.to ?? '',
    ]),
  ]
  return toCsv([...LADDER_COLUMNS], rows)
}

/* ----------------------------------------------------------------- plan --- */

export async function planLadderImport(db: SqlDriver, text: string): Promise<LadderPlan> {
  const { headers, rows } = parseCsvRecords(text)
  const known = new Set<string>(LADDER_COLUMNS.map(header))
  const everyone = await defaultPriceListId(db)
  const boxPrices = await isOn(db, 'unitPrices')

  const products = await q(db)
    .select({ id: schema.products.id, name: schema.products.name, barcode: schema.products.barcode, baseUnit: schema.products.baseUnit })
    .from(schema.products).where(isNull(schema.products.deletedAt))
  const codes = await q(db)
    .select({ productId: schema.productBarcodes.productId, barcode: schema.productBarcodes.barcode })
    .from(schema.productBarcodes).where(isNull(schema.productBarcodes.deletedAt))
  const lists = await q(db)
    .select({ id: schema.priceLists.id, name: schema.priceLists.name })
    .from(schema.priceLists).where(isNull(schema.priceLists.deletedAt))
  const people = await q(db)
    .select({ id: schema.customers.id, name: schema.customers.name })
    .from(schema.customers).where(isNull(schema.customers.deletedAt))

  const byId = new Map(products.map((p) => [p.id, p]))
  const byCode = new Map<string, Set<string>>()
  const hold = (code: string | null, id: string) => {
    if (code) byCode.set(code.trim(), (byCode.get(code.trim()) ?? new Set()).add(id))
  }
  for (const p of products) hold(p.barcode, p.id)
  for (const c of codes) if (byId.has(c.productId)) hold(c.barcode, c.productId)
  const byName = new Map<string, string[]>()
  for (const p of products) byName.set(norm(p.name), [...(byName.get(norm(p.name)) ?? []), p.id])

  const problems: LadderRowProblem[] = []
  const groups = new Map<string, PlannedLadder & { rateless: boolean; broken: boolean }>()

  for (const { line, values } of rows) {
    const get = (c: string) => (values[header(c)] ?? '').trim()
    const itemName = get('item')
    const say = (problem: LadderProblem) => problems.push({ line, item: itemName, problem })

    // The item: by barcode, then by an exact name that only one item has.
    const code = get('barcode')
    let productId: string | null = null
    if (code !== '') {
      const ids = [...(byCode.get(code) ?? [])]
      const named = ids.filter((id) => itemName === '' || norm(byId.get(id)!.name) === norm(itemName))
      if (ids.length === 1) productId = ids[0]!
      else if (named.length === 1) productId = named[0]!
      else if (ids.length > 1) { say('ITEM_AMBIGUOUS'); continue }
    }
    if (productId === null) {
      if (itemName === '') { say('NO_ITEM'); continue }
      const ids = byName.get(norm(itemName)) ?? []
      if (ids.length === 0) { say('UNKNOWN_ITEM'); continue }
      if (ids.length > 1) { say('ITEM_AMBIGUOUS'); continue }
      productId = ids[0]!
    }
    const product = byId.get(productId)!

    // Who it is for.
    const listName = get('price_list')
    const customerName = get('customer')
    let target: LadderTarget
    if (listName !== '' && customerName !== '') { say('LIST_AND_CUSTOMER'); continue }
    if (customerName !== '') {
      const found = people.filter((c) => norm(c.name) === norm(customerName))
      if (found.length === 0) { say('UNKNOWN_CUSTOMER'); continue }
      if (found.length > 1) { say('CUSTOMER_AMBIGUOUS'); continue }
      target = { kind: 'customer', customerId: found[0]!.id, name: found[0]!.name }
    } else if (listName !== '') {
      const found = lists.find((l) => norm(l.name) === norm(listName))
      if (!found) { say('UNKNOWN_LIST'); continue }
      target = found.id === everyone ? { kind: 'everyone' } : { kind: 'list', priceListId: found.id, name: found.name }
    } else {
      target = { kind: 'everyone' }
    }

    if (target.kind === 'everyone' && !everyone) { say('UNKNOWN_LIST'); continue }
    // The unit as the item spells it, so `Box` in a file is the item's `box`.
    const typedUnit = get('unit')
    const typedBase = typedUnit === '' || norm(typedUnit) === norm(product.baseUnit)
      // A file kept from before the unit was renamed: the old word is still one of it.
      || await formerBaseUnit(db, productId, typedUnit)
    const saleUnit = typedBase ? product.baseUnit : typedUnit
    if (target.kind === 'everyone' && saleUnit !== product.baseUnit && !boxPrices) { say('UNIT_PRICES_OFF'); continue }
    const key = `${target.kind === 'list' ? target.priceListId : target.kind === 'customer' ? target.customerId : 'everyone'}|${productId}|${norm(saleUnit)}`
    const group = groups.get(key) ?? {
      key, target, productId, productName: product.name, saleUnit, rungs: [], validFrom: null, validTo: null,
      change: 'new' as const, lines: [], rateless: false, broken: false,
    }
    groups.set(key, group)
    group.lines.push(line)

    const rateText = get('rate')
    const qtyText = get('min_qty')
    const minQty = qtyText === '' ? 0 as Qty : parseQty(qtyText)
    if (minQty === null || minQty < 0) { say('BAD_QTY'); group.broken = true; continue }
    if (rateText === '') { group.rateless = true; continue }
    const rate = parseMoney(rateText)
    if (rate === null || rate < 0) { say('BAD_RATE'); group.broken = true; continue }
    if (target.kind === 'everyone' && saleUnit === product.baseUnit && minQty <= QTY_SCALE) {
      say('EVERYONE_NEEDS_QTY'); group.broken = true; continue
    }
    if (group.rungs.some((r) => r.minQty === minQty)) { say('REPEATED_QTY'); group.broken = true; continue }

    const from = dateOf(get('from'))
    const to = dateOf(get('to'))
    if (from === undefined || to === undefined || (from && to && from > to)) { say('BAD_DATE'); group.broken = true; continue }
    if (group.rungs.length > 0 && (from !== group.validFrom || to !== group.validTo)) {
      say('DATES_DIFFER'); group.broken = true; continue
    }
    group.validFrom = from
    group.validTo = to
    group.rungs.push({ minQty, rate })
  }

  const ladders: PlannedLadder[] = []
  for (const g of groups.values()) {
    const { rateless, broken, ...ladder } = g
    if (broken) {
      // Every other line of a ladder that cannot be written as a whole.
      const said = new Set(problems.map((p) => p.line))
      for (const line of g.lines) if (!said.has(line)) problems.push({ line, item: g.productName, problem: 'LADDER_SKIPPED' })
      continue
    }
    ladder.rungs.sort((a, b) => a.minQty - b.minQty)
    const before = await current(db, ladder, everyone)
    ladder.change = ladder.rungs.length === 0 && rateless
      ? (before.length === 0 ? 'same' : 'clear')
      : before.length === 0 ? 'new'
      : sameRungs(before, ladder.rungs) ? 'same' : 'change'
    ladders.push(ladder)
  }

  problems.sort((a, b) => a.line - b.line)
  return {
    ladders,
    problems,
    unknownColumns: headers.filter((h) => h !== '' && !known.has(h)),
    rows: rows.length,
  }
}

/* ---------------------------------------------------------------- apply --- */

export interface LadderImportResult {
  written: number
  cleared: number
  /** Ladders below cost, not written: the screen asks whether to write them anyway. */
  belowCost: { ladder: PlannedLadder; refusal: BelowCostRefusal }[]
  /** Refused for a reason other than cost, with that reason. */
  failed: { ladder: PlannedLadder; code: string }[]
}

export async function applyLadderImport(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  ladders: PlannedLadder[],
  opts: { allowBelowCost?: boolean } = {},
): Promise<LadderImportResult> {
  const everyone = await defaultPriceListId(db)
  const result: LadderImportResult = { written: 0, cleared: 0, belowCost: [], failed: [] }
  for (const ladder of ladders) {
    if (ladder.change === 'same') continue
    const common = {
      productId: ladder.productId, saleUnit: ladder.saleUnit, rungs: ladder.rungs,
      validFrom: ladder.validFrom, validTo: ladder.validTo,
      ...(opts.allowBelowCost ? { allowBelowCost: true } : {}),
    }
    const written = ladder.target.kind === 'customer'
      ? await setCustomerLadder(db, ctx, { ...common, customerId: ladder.target.customerId })
      : await setLadder(db, ctx, {
        ...common, priceListId: ladder.target.kind === 'list' ? ladder.target.priceListId : everyone!,
      })
    if (written.ok) {
      if (ladder.change === 'clear') result.cleared += 1
      else result.written += 1
    } else if (written.code === 'BELOW_COST') {
      result.belowCost.push({ ladder, refusal: written })
    } else {
      result.failed.push({ ladder, code: written.code })
    }
  }
  return result
}

/* -------------------------------------------------------------- helpers --- */

async function current(db: SqlDriver, ladder: PlannedLadder, everyone: string | null): Promise<Rung[]> {
  if (ladder.target.kind === 'customer') {
    return q(db)
      .select({ minQty: schema.customerItemPrices.minQty, rate: schema.customerItemPrices.rate })
      .from(schema.customerItemPrices)
      .where(and(
        eq(schema.customerItemPrices.customerId, ladder.target.customerId),
        eq(schema.customerItemPrices.productId, ladder.productId),
        eq(schema.customerItemPrices.saleUnit, ladder.saleUnit),
        isNull(schema.customerItemPrices.deletedAt),
      ))
      .orderBy(schema.customerItemPrices.minQty)
  }
  const listId = ladder.target.kind === 'list' ? ladder.target.priceListId : everyone
  if (!listId) return []
  return q(db)
    .select({ minQty: schema.itemPrices.minQty, rate: schema.itemPrices.rate })
    .from(schema.itemPrices)
    .where(and(
      eq(schema.itemPrices.priceListId, listId),
      eq(schema.itemPrices.productId, ladder.productId),
      eq(schema.itemPrices.saleUnit, ladder.saleUnit),
      isNull(schema.itemPrices.deletedAt),
    ))
    .orderBy(schema.itemPrices.minQty)
}

function sameRungs(a: Rung[], b: Rung[]): boolean {
  return a.length === b.length && a.every((r, i) => r.minQty === b[i]!.minQty && r.rate === b[i]!.rate)
}

/**
 * A date as the shop's calendar names it, `YYYY-MM-DD`. Also read as Excel
 * tends to rewrite one in India -- 31-12-2026 or 31/12/2026. Blank is null;
 * undefined is a date that cannot be read.
 */
function dateOf(text: string): string | null | undefined {
  if (text === '') return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text)
  const [y, m, d] = iso ? [iso[1]!, iso[2]!, iso[3]!] : dmy ? [dmy[3]!, dmy[2]!.padStart(2, '0'), dmy[1]!.padStart(2, '0')] : []
  if (!y) return undefined
  const at = new Date(`${y}-${m}-${d}T00:00:00Z`)
  if (Number.isNaN(at.getTime()) || at.getUTCDate() !== Number(d)) return undefined
  return `${y}-${m}-${d}`
}
