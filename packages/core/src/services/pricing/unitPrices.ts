import { eq, and, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import { qty, QTY_SCALE, type Qty } from '../../quantity.js'
import { addTax, splitTax } from '../../domain/tax.js'
import { resolvePrice } from '../../domain/pricing.js'
import { writeAudit, type AuditContext } from '../../integrity/audit.js'
import { requirePermission } from '../../integrity/permissions.js'
import { defaultPriceListId, listIncludesTax, loadPriceCandidates } from '../../repos/pricing.js'
import { isOn } from '../features.js'
import type { BelowCostRefusal } from '../belowCost.js'
import { removeItemPrice, setItemPrice } from './itemPrices.js'

/*
 * A box's own price and its own MRP, for everyone (079).
 *
 * A pen is ₹10 and a box of ten is printed ₹90 and sold at ₹85. The ₹85 is a
 * rate on the shop's own list in the box unit, starting at one box -- where
 * the counter has always looked for it -- and the ₹90 is on the unit's row.
 * Both are set on the item's form, beside the unit, and only with "Box prices
 * and MRP" on; off, the counter prices a box as its pieces and these are kept
 * for when it is turned back on (`repos/pricing.ts`).
 *
 * Breaks on the box itself -- five boxes or more at ₹80 -- are the CSV's
 * business. Saving the price of one box here leaves them as they are.
 */

export interface UnitPrice {
  saleUnit: string
  baseUnits: Qty
  /** Printed on one of this unit. Null: none, and it reads as its pieces'. */
  mrp: Money | null
  /** What one of this unit sells for, GST in. Null: its pieces' price. */
  rate: Money | null
  /** What one of this unit comes to as its pieces, GST in -- the price when `rate` is null. */
  asPieces: Money
}

export interface UnitPriceInput {
  saleUnit: string
  mrp: Money | null
  rate: Money | null
}

export type SetUnitPricesResult =
  | { ok: true }
  | { ok: false; code: 'UNKNOWN_UNIT'; saleUnit: string }
  | { ok: false; code: 'BAD_AMOUNT'; saleUnit: string }
  /** The price typed for the box is more than the MRP printed on it. */
  | { ok: false; code: 'ABOVE_MRP'; saleUnit: string; rate: Money; mrp: Money }
  /** No price was typed, and the box as its pieces comes to more than its MRP. */
  | { ok: false; code: 'PIECES_ABOVE_MRP'; saleUnit: string; rate: Money; mrp: Money }
  | BelowCostRefusal

/** Each of an item's bigger units with its own MRP and price for everyone. */
export async function unitPrices(db: SqlDriver, productId: string): Promise<UnitPrice[]> {
  const listId = await defaultPriceListId(db)
  const withTax = await listIncludesTax(db, listId)
  const tax = await taxOf(db, productId)
  const units = await q(db)
    .select({ saleUnit: schema.productUnits.saleUnit, baseUnits: schema.productUnits.baseUnits, mrp: schema.productUnits.mrp })
    .from(schema.productUnits)
    .where(and(eq(schema.productUnits.productId, productId), isNull(schema.productUnits.deletedAt)))
    .orderBy(schema.productUnits.baseUnits)

  const out: UnitPrice[] = []
  for (const u of units) {
    const one = listId ? await priceOfOne(db, listId, productId, u.saleUnit) : null
    out.push({
      ...u,
      rate: one === null ? null : withTax ? one.rate : shelf(one.rate, tax),
      asPieces: await asPieces(db, productId, u.saleUnit, tax),
    })
  }
  return out
}

/**
 * Writes each unit's MRP and price for everyone. Every figure is checked
 * before any is written, so a refusal leaves the item as it was.
 */
export async function setUnitPrices(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; units: UnitPriceInput[]; allowBelowCost?: boolean },
): Promise<SetUnitPricesResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  const listId = await defaultPriceListId(db)
  const withTax = await listIncludesTax(db, listId)
  const tax = await taxOf(db, input.productId)
  const before = new Map((await unitPrices(db, input.productId)).map((u) => [u.saleUnit, u]))

  for (const unit of input.units) {
    const was = before.get(unit.saleUnit)
    if (!was || !listId) return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: unit.saleUnit }
    for (const amount of [unit.mrp, unit.rate]) {
      if (amount !== null && (!Number.isInteger(amount) || amount < 0)) return { ok: false, code: 'BAD_AMOUNT', saleUnit: unit.saleUnit }
    }
    if (unit.mrp === null) continue
    /* Never above what the box says. A typed price over it is a typo; a box
       left to its pieces that comes to more than its MRP would be charged
       illegally at every sale, and the fix is a price at or under it. */
    if (unit.rate !== null && unit.rate > unit.mrp) {
      return { ok: false, code: 'ABOVE_MRP', saleUnit: unit.saleUnit, rate: unit.rate, mrp: unit.mrp }
    }
    if (unit.rate === null && was.asPieces > unit.mrp) {
      return { ok: false, code: 'PIECES_ABOVE_MRP', saleUnit: unit.saleUnit, rate: was.asPieces, mrp: unit.mrp }
    }
  }

  // Prices first: one refused for being below cost leaves every MRP as it was too.
  for (const unit of input.units) {
    const was = before.get(unit.saleUnit)!
    if (unit.rate === was.rate) continue
    const one = await priceOfOne(db, listId!, input.productId, unit.saleUnit)
    if (unit.rate === null) {
      if (one) await removeItemPrice(db, ctx, one.id)
      continue
    }
    // Kept the way the shop's list quotes, as every rate on it is.
    const written = await setItemPrice(db, ctx, {
      productId: input.productId, priceListId: listId!, saleUnit: unit.saleUnit, minQty: qty(QTY_SCALE),
      rate: withTax ? unit.rate : splitTax(unit.rate, tax.rateBp, 'intra_state', tax.cessBp).taxableValue,
      validFrom: null, validTo: null, allowBelowCost: input.allowBelowCost === true,
    })
    if (!written.ok) {
      if (written.code === 'BELOW_COST') return written
      return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: unit.saleUnit }
    }
  }

  const now = ctx.now?.() ?? new Date().toISOString()
  for (const unit of input.units) {
    const was = before.get(unit.saleUnit)!
    if (unit.mrp === was.mrp) continue
    await db.transaction(async (tx) => {
      await q(tx).update(schema.productUnits)
        .set({ mrp: unit.mrp, updatedAt: now })
        .where(and(eq(schema.productUnits.productId, input.productId), eq(schema.productUnits.saleUnit, unit.saleUnit)))
      await writeAudit(tx, ctx, {
        entity: 'products', entityId: input.productId, action: 'update',
        before: { [`${unit.saleUnit} MRP`]: was.mrp }, after: { [`${unit.saleUnit} MRP`]: unit.mrp },
      })
    })
  }
  return { ok: true }
}

/* -------------------------------------------------------------- helpers --- */

interface ItemTax { rateBp: number; cessBp: number }

async function taxOf(db: SqlDriver, productId: string): Promise<ItemTax> {
  const [row] = await q(db)
    .select({ rateBp: schema.products.taxRateBp, cessBp: schema.products.cessRateBp })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  return { rateBp: row?.rateBp ?? 0, cessBp: row?.cessBp ?? 0 }
}

/** A rate quoted before tax, as the shelf reads it. */
function shelf(rate: Money, tax: ItemTax): Money {
  return (rate + addTax(rate, tax.rateBp, 'intra_state', tax.cessBp).taxTotal) as Money
}

/** The rung at one of this unit on the shop's own list, which is the unit's price for everyone. */
async function priceOfOne(
  db: SqlDriver, listId: string, productId: string, saleUnit: string,
): Promise<{ id: string; rate: Money } | null> {
  const [row] = await q(db)
    .select({ id: schema.itemPrices.id, rate: schema.itemPrices.rate })
    .from(schema.itemPrices)
    .where(and(
      eq(schema.itemPrices.productId, productId),
      eq(schema.itemPrices.priceListId, listId),
      eq(schema.itemPrices.saleUnit, saleUnit),
      eq(schema.itemPrices.minQty, qty(QTY_SCALE)),
      isNull(schema.itemPrices.deletedAt),
    ))
  return row ?? null
}

/**
 * One of the unit as its pieces: the selling rate times how many it holds,
 * less any quantity break it reaches -- what the counter charges a box with no
 * price of its own.
 */
async function asPieces(db: SqlDriver, productId: string, saleUnit: string, tax: ItemTax): Promise<Money> {
  const listId = await defaultPriceListId(db)
  const candidates = await loadPriceCandidates(db, {
    productId, saleUnit, defaultPriceListId: listId,
    quantityBreaks: await isOn(db, 'tieredPricing'), unitPrices: false,
  })
  const priced = resolvePrice(candidates, qty(QTY_SCALE))
  return priced.source === 'default_list' && !(await listIncludesTax(db, listId)) ? shelf(priced.rate, tax) : priced.rate
}
