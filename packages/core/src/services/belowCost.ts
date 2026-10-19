import { eq, inArray } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { resolveSaleUnit } from '../repos/pricing.js'
import type { Money } from '../money.js'
import { costHints } from '../repos/costs.js'
import { QTY_SCALE, qty, type Qty } from '../quantity.js'
import { floorOf, netPerBase } from '../domain/costFloor.js'
import { addTax } from '../domain/tax.js'
import { requirePermission, PermissionError } from '../integrity/permissions.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { inputTaxClaimable } from './purchases.js'

/**
 * Nothing sells, and nothing is priced to sell, below what it cost.
 *
 * Asked at every place a selling price is set or a sale is made -- a bill at
 * the moment it is paid, an item's selling rate, a rate on a price list or for
 * one customer, the price a delivery's batch sells at -- and answered the same
 * way at all of them, which is why it is one function and not five.
 *
 * "What it cost" is what the person sees and sets (`costHints`): the last price
 * paid, or the cost price typed on the item if that is newer. An item with
 * neither has no floor, and is never refused for want of one.
 *
 * Refused for everybody. A role with `below_cost` `write` -- Admin's by default
 * -- may go ahead once it says so (`allow`), for the clearance sale or the
 * stock about to go off, and each time it does is written to the audit trail
 * with the prices and the costs. The refusal says whether this person could, so
 * the screen knows whether to offer the question or only the answer.
 */

/** A price to hold up against the cost: per base unit, without the GST it carries (`domain/costFloor.ts`). */
export interface PriceToCheck {
  productId: string
  name: string
  perBase: Money
}

export interface UnderCost {
  productId: string
  name: string
  /** What one base unit would sell for, without GST. */
  sellsAt: Money
  /** The least it may sell for: its cost, with GST where the shop cannot claim it back. */
  cost: Money
}

export interface BelowCostRefusal {
  ok: false
  code: 'BELOW_COST'
  lines: UnderCost[]
  /** Whether this person may go ahead by asking again with `allow`. */
  mayAllow: boolean
}

/**
 * A rate as somebody types it -- for one sale unit, with GST in it or not --
 * as the figure to hold against the cost. GST comes out only where the shop
 * charges it: a shop that does not keeps all of what it is paid.
 */
export async function priceToCheck(db: SqlDriver, input: {
  productId: string
  name: string
  rate: Money
  includesTax: boolean
  taxRateBp: number
  cessRateBp: number
  /** How many base units the rate is for, × QTY_SCALE. Absent is one. */
  baseUnits?: Qty
}): Promise<PriceToCheck> {
  return {
    productId: input.productId,
    name: input.name,
    perBase: netPerBase({
      rate: input.rate,
      includesTax: input.includesTax,
      taxRateBp: input.taxRateBp,
      cessRateBp: input.cessRateBp,
      baseUnits: input.baseUnits ?? qty(QTY_SCALE),
      charges: await inputTaxClaimable(db),
    }),
  }
}

/**
 * The same question for a rate typed against one of an item's units on a
 * price list or for one customer: read the item's GST and the unit's size
 * here, so the services that write rates need not.
 */
export async function rateRefusal(
  db: SqlDriver,
  ctx: AuditContext,
  input: {
    productId: string; saleUnit: string; rate: Money; includesTax: boolean
    allow?: boolean; entity: string; entityId: string
  },
): Promise<BelowCostRefusal | null> {
  const [item] = await q(db)
    .select({ name: schema.products.name, taxRateBp: schema.products.taxRateBp, cessRateBp: schema.products.cessRateBp })
    .from(schema.products)
    .where(eq(schema.products.id, input.productId))
  if (!item) return null
  const unit = await resolveSaleUnit(db, input.productId, input.saleUnit)
  const price = await priceToCheck(db, {
    productId: input.productId, name: item.name, rate: input.rate, includesTax: input.includesTax,
    taxRateBp: item.taxRateBp, cessRateBp: item.cessRateBp, baseUnits: unit.baseUnits,
  })
  return belowCostRefusal(db, ctx, [price], {
    ...(input.allow === undefined ? {} : { allow: input.allow }), entity: input.entity, entityId: input.entityId,
  })
}

/** The least one base unit at this cost may sell for: with its GST where the shop cannot claim that back. */
export async function floorAt(db: SqlDriver, unitCost: Money, taxPerUnit: Money): Promise<Money> {
  return floorOf(unitCost, taxPerUnit, await inputTaxClaimable(db))
}

/** The least each item may sell for per base unit, where its cost is known. */
export async function costFloors(db: SqlDriver, productIds: readonly string[]): Promise<Map<string, Money>> {
  const [hints, claimable] = await Promise.all([costHints(db, productIds), inputTaxClaimable(db)])
  const floors = new Map<string, Money>()
  for (const [id, hint] of hints) floors.set(id, floorOf(hint.unitCost, hint.taxPerUnit, claimable))
  return floors
}

/**
 * The prices among these that are below cost. A price of nothing is not a
 * price, and is not checked. `known` gives the floor outright where the caller
 * holds a better cost than the last one recorded -- the delivery being entered.
 */
export async function underCost(
  db: SqlDriver, prices: readonly PriceToCheck[], known?: ReadonlyMap<string, Money>,
): Promise<UnderCost[]> {
  const asked = prices.filter((p) => p.perBase > 0)
  if (asked.length === 0) return []
  const floors = new Map(await costFloors(db, asked.map((p) => p.productId).filter((id) => !known?.has(id))))
  for (const [id, floor] of known ?? []) floors.set(id, floor)
  const under: UnderCost[] = []
  for (const p of asked) {
    const cost = floors.get(p.productId)
    if (cost !== undefined && p.perBase < cost) {
      under.push({ productId: p.productId, name: p.name, sellsAt: p.perBase, cost })
    }
  }
  return under
}

/** Whether this person may sell below cost once they have said so. */
export async function mayAllowBelowCost(db: SqlDriver, actorId: string | null): Promise<boolean> {
  try {
    await requirePermission(db, actorId, 'below_cost', 'write')
    return true
  } catch (err) {
    if (err instanceof PermissionError) return false
    throw err
  }
}

/**
 * Null when every price is at or above cost, or when this person may go
 * below it and has said so -- which is then put on the audit trail against
 * `entity`. Otherwise the refusal, saying which items and by how much.
 *
 * Pass the transaction the change is written in, so the record of an allowed
 * sale stands or falls with the sale.
 */
export async function belowCostRefusal(
  db: SqlDriver,
  ctx: AuditContext,
  prices: readonly PriceToCheck[],
  opts: { allow?: boolean; entity: string; entityId: string; known?: ReadonlyMap<string, Money> },
): Promise<BelowCostRefusal | null> {
  const lines = await underCost(db, prices, opts.known)
  if (lines.length === 0) return null
  const mayAllow = await mayAllowBelowCost(db, ctx.actorId)
  if (mayAllow && opts.allow === true) {
    await writeAudit(db, ctx, {
      entity: opts.entity,
      entityId: opts.entityId,
      action: 'update',
      after: {
        below_cost: lines
          .map((l) => `${l.name}: ${(l.sellsAt / 100).toFixed(2)} under ${(l.cost / 100).toFixed(2)}`)
          .join('; '),
      },
    })
    return null
  }
  return { ok: false, code: 'BELOW_COST', lines, mayAllow }
}

/**
 * Rows of a catalogue file whose rate would sell the item below what it cost,
 * by `key`. A new item (no `productId`) is held against the cost in the file;
 * one already here against its latest recorded. A row with no cost to go on,
 * or no rate, is left alone, as everywhere else. `services/import.ts` turns
 * these into refusals on the plan.
 */
export async function importRowsUnderCost(db: SqlDriver, rows: readonly {
  key: number; name: string; productId: string | null
  rate: Money | null; cost: Money | null; taxRateBp: number | null
}[]): Promise<Set<number>> {
  const under = new Set<number>()
  const priced = rows.filter((r) => r.rate !== null && r.rate > 0)
  if (priced.length === 0) return under
  const known = priced.flatMap((r) => (r.productId ? [r.productId] : []))
  const floors = await costFloors(db, known)
  const rates = known.length === 0 ? [] : await q(db)
    .select({ id: schema.products.id, taxRateBp: schema.products.taxRateBp, cessRateBp: schema.products.cessRateBp })
    .from(schema.products)
    .where(inArray(schema.products.id, known))
  const ratesOf = new Map(rates.map((r) => [r.id, r]))

  for (const row of priced) {
    const held = row.productId ? ratesOf.get(row.productId) : undefined
    const taxRateBp = row.taxRateBp ?? held?.taxRateBp ?? 0
    const cessRateBp = held?.cessRateBp ?? 0
    const floor = row.productId
      ? floors.get(row.productId)
      : row.cost !== null && row.cost > 0
        ? await floorAt(db, row.cost, addTax(row.cost, taxRateBp, 'intra_state', cessRateBp).taxTotal)
        : undefined
    if (floor === undefined) continue
    const price = await priceToCheck(db, {
      productId: row.productId ?? '', name: row.name, rate: row.rate as Money, includesTax: true, taxRateBp, cessRateBp,
    })
    if (price.perBase < floor) under.add(row.key)
  }
  return under
}
