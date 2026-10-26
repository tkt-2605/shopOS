import { eq, and, isNull, notInArray, asc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { derivedId } from '../../ids.js'
import type { Money } from '../../money.js'
import { qty, type Qty, QTY_SCALE } from '../../quantity.js'
import { writeAudit, type AuditContext } from '../../integrity/audit.js'
import { requirePermission } from '../../integrity/permissions.js'
import { formerBaseUnit } from '../../repos/pricing.js'

/*
 * The units a product sells in, and how many of its base unit each one is.
 */

export interface SaleUnit {
  id: string
  saleUnit: string
  /** How many base units one of these is. A ream is 500 sheets. */
  baseUnits: Qty
  isDefault: boolean
}

export interface SaleUnitInput {
  saleUnit: string
  baseUnits: Qty
  isDefault?: boolean
}

export type SetUnitsResult =
  | { ok: true; units: SaleUnit[] }
  | { ok: false; code: 'BAD_FACTOR'; saleUnit: string }
  | { ok: false; code: 'CLASHES_WITH_BASE'; saleUnit: string }
  /** What the item's own unit used to be called: it still means one of it on older bills and quotes. */
  | { ok: false; code: 'WAS_THE_BASE'; saleUnit: string }
  | { ok: false; code: 'IN_USE'; saleUnit: string; billCount: number }

export async function listUnits(db: SqlDriver, productId: string): Promise<SaleUnit[]> {
  const rows = await q(db)
    .select({
      id: schema.productUnits.id,
      saleUnit: schema.productUnits.saleUnit,
      baseUnits: schema.productUnits.baseUnits,
      isDefault: schema.productUnits.isDefault,
    })
    .from(schema.productUnits)
    .where(and(eq(schema.productUnits.productId, productId), isNull(schema.productUnits.deletedAt)))
    .orderBy(asc(schema.productUnits.baseUnits))

  return rows.map((r) => ({ ...r, isDefault: r.isDefault === 1 }))
}

/**
 * Replaces the sale units of a product.
 *
 * The base unit is not in this list and cannot be: it is the thing everything
 * else is counted in, stock is held in, and valuation is calculated in. A pack
 * is ten pieces; the piece is not a pack of anything.
 *
 * A unit that bills have already been written against is not removable. Those
 * bills name it, and a stock ledger derived from a factor that has been
 * deleted cannot be re-derived.
 */
export async function setUnits(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productId: string,
  inputs: SaleUnitInput[],
): Promise<SetUnitsResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const [product] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), isNull(schema.products.deletedAt)))
  if (!product) throw new Error('no such product')

  const cleaned: SaleUnitInput[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const name = input.saleUnit.trim()
    if (name === '' || seen.has(name)) continue
    if (name === product.baseUnit) return { ok: false, code: 'CLASHES_WITH_BASE', saleUnit: name }
    if (await formerBaseUnit(db, productId, name)) return { ok: false, code: 'WAS_THE_BASE', saleUnit: name }
    if (input.baseUnits <= 0) return { ok: false, code: 'BAD_FACTOR', saleUnit: name }
    seen.add(name)
    cleaned.push({ saleUnit: name, baseUnits: input.baseUnits, isDefault: input.isDefault ?? false })
  }

  const existing = await listUnits(db, productId)
  for (const unit of existing) {
    if (seen.has(unit.saleUnit)) continue
    const [used] = await q(db)
      .select({ n: sql<number>`COUNT(*)` })
      .from(schema.billItems)
      .where(and(
        eq(schema.billItems.productId, productId),
        eq(schema.billItems.saleUnit, unit.saleUnit),
      ))
    if ((used?.n ?? 0) > 0) {
      return { ok: false, code: 'IN_USE', saleUnit: unit.saleUnit, billCount: used?.n ?? 0 }
    }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    /* Taken off, not deleted (056): a removal is an edit and merges like one,
       where a delete left a tombstone that a third till could outlive. */
    const keep = cleaned.map((u) => u.saleUnit)
    await q(tx).update(schema.productUnits)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(
        eq(schema.productUnits.productId, productId),
        isNull(schema.productUnits.deletedAt),
        ...(keep.length > 0 ? [notInArray(schema.productUnits.saleUnit, keep)] : []),
      ))

    for (const input of cleaned) {
      /* Derived, not minted. The whole set is rewritten on every save, so a
         unit nobody touched used to come back under a new id — two tills doing
         that mint two, and the shop ends up holding "box of 12" twice. Derived
         from the product and the unit name, the rewrite writes the row both
         tills already agreed on, and the feed collapses the delete and the
         insert into one upsert of that row. */
      /* The unit the item already had, or had and lost, is the row it always
         was: found by product and name, which is what is unique, rather than
         by the derived id a row written before ids were derived does not have. */
      const [held] = await q(tx)
        .select({ id: schema.productUnits.id })
        .from(schema.productUnits)
        .where(and(eq(schema.productUnits.productId, productId), eq(schema.productUnits.saleUnit, input.saleUnit)))
      if (held) {
        await q(tx).update(schema.productUnits)
          .set({ baseUnits: input.baseUnits, isDefault: input.isDefault ? 1 : 0, updatedAt: now, deletedAt: null })
          .where(eq(schema.productUnits.id, held.id))
        continue
      }
      await q(tx).insert(schema.productUnits).values({
        id: await derivedId('product_units', productId, input.saleUnit),
        productId,
        saleUnit: input.saleUnit,
        baseUnits: input.baseUnits,
        isDefault: input.isDefault ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
    }
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: productId, action: 'update',
      before: { units: existing.map((u) => u.saleUnit).join(', ') || null },
      after: { units: cleaned.map((u) => u.saleUnit).join(', ') || null },
    })
  })

  return { ok: true, units: await listUnits(db, productId) }
}

/* ------------------------------------------------------ renaming the base --- */

export type RenameBaseUnitResult =
  | { ok: true; from: string; to: string }
  | { ok: false; code: 'BAD_NAME' }
  /** The item already sells in a unit by that name: a box cannot also be what a box is counted in. */
  | { ok: false; code: 'NAME_TAKEN'; name: string }
  | { ok: false; code: 'UNKNOWN_PRODUCT' }

/**
 * Calls the unit an item is counted in by another word: piece as pcs.
 *
 * Only the word. Stock, bills, valuation and every break are counted in the
 * same thing they always were, so nothing is converted -- which is why this is
 * safe where changing what the item is counted in is not (a pen with 500 in
 * stock "becoming" a box would be 500 boxes).
 *
 * The item's prices for that unit, on every list and for every customer, move
 * to the new word. Old bills keep the word they were written with. And the old
 * word stays behind as a retired unit of one (`resolveSaleUnit`), so a held
 * bill, a quotation turned into a bill next week or a price file kept from
 * before still finds it, and means exactly one of the new.
 */
export async function renameBaseUnit(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; name: string },
): Promise<RenameBaseUnitResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const to = input.name.trim()
  if (to === '' || to.length > 40) return { ok: false, code: 'BAD_NAME' }
  const [product] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(and(eq(schema.products.id, input.productId), isNull(schema.products.deletedAt)))
  if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT' }
  const from = product.baseUnit
  if (to === from) return { ok: true, from, to }

  const [live] = await q(db)
    .select({ id: schema.productUnits.id })
    .from(schema.productUnits)
    .where(and(
      eq(schema.productUnits.productId, input.productId),
      eq(schema.productUnits.saleUnit, to),
      isNull(schema.productUnits.deletedAt),
    ))
  if (live) return { ok: false, code: 'NAME_TAKEN', name: to }
  // A price already written under the new word could only be a stray, and would collide with the move.
  const [stray] = await q(db)
    .select({ id: schema.itemPrices.id })
    .from(schema.itemPrices)
    .where(and(eq(schema.itemPrices.productId, input.productId), eq(schema.itemPrices.saleUnit, to)))
  const [strayOwn] = await q(db)
    .select({ id: schema.customerItemPrices.id })
    .from(schema.customerItemPrices)
    .where(and(eq(schema.customerItemPrices.productId, input.productId), eq(schema.customerItemPrices.saleUnit, to)))
  if (stray || strayOwn) return { ok: false, code: 'NAME_TAKEN', name: to }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.products)
      .set({ baseUnit: to, updatedAt: now })
      .where(eq(schema.products.id, input.productId))
    await q(tx).update(schema.itemPrices)
      .set({ saleUnit: to, updatedAt: now })
      .where(and(eq(schema.itemPrices.productId, input.productId), eq(schema.itemPrices.saleUnit, from)))
    await q(tx).update(schema.customerItemPrices)
      .set({ saleUnit: to, updatedAt: now })
      .where(and(eq(schema.customerItemPrices.productId, input.productId), eq(schema.customerItemPrices.saleUnit, from)))

    /* The old word, kept as a retired unit of one: never offered at the
       counter (it is taken off), and found by `resolveSaleUnit` for anything
       still written in it. */
    const [held] = await q(tx)
      .select({ id: schema.productUnits.id })
      .from(schema.productUnits)
      .where(and(eq(schema.productUnits.productId, input.productId), eq(schema.productUnits.saleUnit, from)))
    if (held) {
      await q(tx).update(schema.productUnits)
        .set({ baseUnits: qty(QTY_SCALE), isDefault: 0, deletedAt: now, updatedAt: now, mrp: null })
        .where(eq(schema.productUnits.id, held.id))
    } else {
      await q(tx).insert(schema.productUnits).values({
        id: await derivedId('product_units', input.productId, from),
        productId: input.productId, saleUnit: from, baseUnits: qty(QTY_SCALE), isDefault: 0,
        createdAt: now, updatedAt: now, deletedAt: now,
      })
    }
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: input.productId, action: 'update',
      before: { unit: from }, after: { unit: to },
    })
  })
  return { ok: true, from, to }
}

/* ----------------------------------------------------------- price lists --- */

/**
 * A rate can only be written against a unit the product actually sells in —
 * otherwise it is a price nothing will ever resolve, sitting in the table
 * looking as though it works.
 */
export async function unitExists(db: SqlDriver, productId: string, saleUnit: string): Promise<boolean> {
  const [base] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), isNull(schema.products.deletedAt)))
  if (!base) return false
  if (base.baseUnit === saleUnit) return true

  const [row] = await q(db)
    .select({ id: schema.productUnits.id })
    .from(schema.productUnits)
    .where(and(
      eq(schema.productUnits.productId, productId),
      eq(schema.productUnits.saleUnit, saleUnit),
      isNull(schema.productUnits.deletedAt),
    ))
  return row !== undefined
}

/**
 * What one base unit costs at a given rate, for showing a shopkeeper whether a
 * pack of ten is actually cheaper than ten pieces.
 */
export function perBaseUnit(rate: Money, baseUnits: Qty): Money {
  if (baseUnits <= 0) return rate
  return Math.round((rate * QTY_SCALE) / baseUnits) as Money
}
