import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import type { Money } from '../money.js'
import { type Qty, qty, QTY_SCALE } from '../quantity.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'

/**
 * Writing prices down.
 *
 * The reading half of this — the four-step chain that decides what a line costs —
 * has existed since v1 in `domain/pricing.ts` and is thoroughly tested. What was
 * missing was any way for a shop to put a price into it: the tables were filled
 * by the demo seed and by nothing else. A pricing engine a shopkeeper cannot
 * reach is not a feature, it is a claim.
 *
 * Everything here is the write side of tables `repos/pricing.ts` already reads.
 */

/* ---------------------------------------------------------------- units --- */

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
  | { ok: false; code: 'IN_USE'; saleUnit: string; billCount: number }

export async function listUnits(db: SqlDriver, productId: string): Promise<SaleUnit[]> {
  const rows = await db.query<{ id: string; sale_unit: string; base_units: number; is_default: number }>(
    `SELECT id, sale_unit, base_units, is_default FROM product_units
      WHERE product_id = ? ORDER BY base_units`,
    [productId],
  )
  return rows.map((r) => ({
    id: r.id, saleUnit: r.sale_unit, baseUnits: qty(r.base_units), isDefault: r.is_default === 1,
  }))
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
  const product = await db.get<{ base_unit: string }>(
    `SELECT base_unit FROM products WHERE id = ? AND deleted_at IS NULL`, [productId],
  )
  if (!product) throw new Error('no such product')

  const cleaned: SaleUnitInput[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const name = input.saleUnit.trim()
    if (name === '' || seen.has(name)) continue
    if (name === product.base_unit) return { ok: false, code: 'CLASHES_WITH_BASE', saleUnit: name }
    if (input.baseUnits <= 0) return { ok: false, code: 'BAD_FACTOR', saleUnit: name }
    seen.add(name)
    cleaned.push({ saleUnit: name, baseUnits: input.baseUnits, isDefault: input.isDefault ?? false })
  }

  const existing = await listUnits(db, productId)
  for (const unit of existing) {
    if (seen.has(unit.saleUnit)) continue
    const used = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bill_items WHERE product_id = ? AND sale_unit = ?`,
      [productId, unit.saleUnit],
    )
    if ((used?.n ?? 0) > 0) {
      return { ok: false, code: 'IN_USE', saleUnit: unit.saleUnit, billCount: used?.n ?? 0 }
    }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    await tx.execute(`DELETE FROM product_units WHERE product_id = ?`, [productId])
    for (const input of cleaned) {
      await tx.execute(
        `INSERT INTO product_units (id, product_id, sale_unit, base_units, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId(), productId, input.saleUnit, input.baseUnits, input.isDefault ? 1 : 0, now, now],
      )
    }
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: productId, action: 'update',
      before: { units: existing.map((u) => u.saleUnit).join(', ') || null },
      after: { units: cleaned.map((u) => u.saleUnit).join(', ') || null },
    })
  })

  return { ok: true, units: await listUnits(db, productId) }
}

/* ----------------------------------------------------------- price lists --- */

export interface PriceList {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
  /** How many customers are on this list, so deleting one is an informed act. */
  customerCount: number
  priceCount: number
}

export async function listPriceLists(db: SqlDriver): Promise<PriceList[]> {
  const rows = await db.query<{
    id: string; name: string; is_default: number; is_active: number
    customers: number; prices: number
  }>(
    `SELECT l.id, l.name, l.is_default, l.is_active,
            (SELECT COUNT(*) FROM customers c WHERE c.price_list_id = l.id AND c.deleted_at IS NULL) AS customers,
            (SELECT COUNT(*) FROM item_prices p WHERE p.price_list_id = l.id AND p.deleted_at IS NULL) AS prices
       FROM price_lists l
      WHERE l.deleted_at IS NULL
      ORDER BY l.is_default DESC, l.name`,
  )
  return rows.map((r) => ({
    id: r.id, name: r.name, isDefault: r.is_default === 1, isActive: r.is_active === 1,
    customerCount: r.customers, priceCount: r.prices,
  }))
}

export type PriceListResult =
  | { ok: true; priceListId: string }
  | { ok: false; code: 'NO_NAME' }
  | { ok: false; code: 'NAME_TAKEN' }

export async function createPriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { name: string; isDefault?: boolean },
): Promise<PriceListResult> {
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }
  const taken = await db.get<{ id: string }>(
    `SELECT id FROM price_lists WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`, [name],
  )
  if (taken) return { ok: false, code: 'NAME_TAKEN' }

  const id = newId()
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    // One default, always: a shop with two has no answer for a walk-in customer.
    if (input.isDefault) await tx.execute(`UPDATE price_lists SET is_default = 0`)
    await tx.execute(
      `INSERT INTO price_lists (id, name, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [id, name, input.isDefault ? 1 : 0, now, now],
    )
    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: id, action: 'create', after: { name, is_default: input.isDefault ? 1 : 0 },
    })
  })

  return { ok: true, priceListId: id }
}

export async function updatePriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { priceListId: string; name?: string; isDefault?: boolean; isActive?: boolean },
): Promise<PriceListResult> {
  const before = await db.get<{ name: string; is_default: number; is_active: number }>(
    `SELECT name, is_default, is_active FROM price_lists WHERE id = ? AND deleted_at IS NULL`,
    [input.priceListId],
  )
  if (!before) throw new Error('no such price list')

  const name = input.name?.trim() ?? before.name
  if (name === '') return { ok: false, code: 'NO_NAME' }
  if (name !== before.name) {
    const taken = await db.get<{ id: string }>(
      `SELECT id FROM price_lists WHERE name = ? COLLATE NOCASE AND id <> ? AND deleted_at IS NULL`,
      [name, input.priceListId],
    )
    if (taken) return { ok: false, code: 'NAME_TAKEN' }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const isDefault = input.isDefault ?? before.is_default === 1
  const isActive = input.isActive ?? before.is_active === 1

  await db.transaction(async (tx) => {
    if (isDefault) await tx.execute(`UPDATE price_lists SET is_default = 0`)
    await tx.execute(
      `UPDATE price_lists SET name = ?, is_default = ?, is_active = ?, updated_at = ?, rev = rev + 1
        WHERE id = ?`,
      [name, isDefault ? 1 : 0, isActive ? 1 : 0, now, input.priceListId],
    )
    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: input.priceListId, action: 'update',
      before: { name: before.name, is_default: before.is_default, is_active: before.is_active },
      after: { name, is_default: isDefault ? 1 : 0, is_active: isActive ? 1 : 0 },
    })
  })

  return { ok: true, priceListId: input.priceListId }
}

/* ----------------------------------------------------------- item prices --- */

export interface ItemPrice {
  id: string
  productId: string
  productName: string
  priceListId: string
  priceListName: string
  saleUnit: string
  /** Buy this many or more and this rate applies. Zero is the plain rate. */
  minQty: Qty
  rate: Money
  validFrom: string | null
  validTo: string | null
}

export interface ItemPriceInput {
  productId: string
  priceListId: string
  saleUnit: string
  minQty?: Qty
  rate: Money
  validFrom?: string | null
  validTo?: string | null
}

export type ItemPriceResult =
  | { ok: true; itemPriceId: string }
  | { ok: false; code: 'BAD_DATES' }
  | { ok: false; code: 'UNKNOWN_UNIT'; saleUnit: string }

export async function listItemPrices(
  db: SqlDriver,
  filter: { productId?: string; priceListId?: string } = {},
): Promise<ItemPrice[]> {
  const where = ['p.deleted_at IS NULL']
  const args: string[] = []
  if (filter.productId) { where.push('p.product_id = ?'); args.push(filter.productId) }
  if (filter.priceListId) { where.push('p.price_list_id = ?'); args.push(filter.priceListId) }

  const rows = await db.query<{
    id: string; product_id: string; product_name: string; price_list_id: string
    price_list_name: string; sale_unit: string; min_qty: number; rate: number
    valid_from: string | null; valid_to: string | null
  }>(
    `SELECT p.id, p.product_id, pr.name AS product_name, p.price_list_id, l.name AS price_list_name,
            p.sale_unit, p.min_qty, p.rate, p.valid_from, p.valid_to
       FROM item_prices p
       JOIN products pr ON pr.id = p.product_id
       JOIN price_lists l ON l.id = p.price_list_id
      WHERE ${where.join(' AND ')}
      ORDER BY pr.name, l.is_default DESC, l.name, p.sale_unit, p.min_qty`,
    args,
  )
  return rows.map((r) => ({
    id: r.id, productId: r.product_id, productName: r.product_name,
    priceListId: r.price_list_id, priceListName: r.price_list_name,
    saleUnit: r.sale_unit, minQty: qty(r.min_qty), rate: r.rate as Money,
    validFrom: r.valid_from, validTo: r.valid_to,
  }))
}

/**
 * Writes one rate.
 *
 * The unique key is (product, list, unit, minimum quantity), so saving the same
 * rung twice replaces it rather than making a second one the resolver would have
 * to choose between.
 */
export async function setItemPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: ItemPriceInput,
): Promise<ItemPriceResult> {
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    return { ok: false, code: 'BAD_DATES' }
  }
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

  const minQty = input.minQty ?? qty(0)
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  const existing = await db.get<{ id: string; rate: number }>(
    `SELECT id, rate FROM item_prices
      WHERE product_id = ? AND price_list_id = ? AND sale_unit = ? AND min_qty = ?`,
    [input.productId, input.priceListId, input.saleUnit, minQty],
  )

  const id = existing?.id ?? newId()
  await db.transaction(async (tx) => {
    if (existing) {
      await tx.execute(
        `UPDATE item_prices SET rate = ?, valid_from = ?, valid_to = ?, deleted_at = NULL,
                                updated_at = ?, rev = rev + 1
          WHERE id = ?`,
        [input.rate, input.validFrom ?? null, input.validTo ?? null, now, id],
      )
    } else {
      await tx.execute(
        `INSERT INTO item_prices
           (id, product_id, price_list_id, sale_unit, min_qty, rate, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.productId, input.priceListId, input.saleUnit, minQty, input.rate,
         input.validFrom ?? null, input.validTo ?? null, now, now],
      )
    }
    await writeAudit(tx, ctx, {
      entity: 'item_prices', entityId: id, action: existing ? 'update' : 'create',
      before: existing ? { rate: existing.rate } : null,
      after: { product_id: input.productId, sale_unit: input.saleUnit, min_qty: minQty, rate: input.rate },
    })
  })

  return { ok: true, itemPriceId: id }
}

export async function removeItemPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  itemPriceId: string,
): Promise<void> {
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    // Soft, because a submitted bill points at this row through price_source_id
    // and support has to be able to answer "why was this ₹42" next March.
    await tx.execute(
      `UPDATE item_prices SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [now, now, itemPriceId],
    )
    await writeAudit(tx, ctx, { entity: 'item_prices', entityId: itemPriceId, action: 'delete' })
  })
}

/* ------------------------------------------------- customer-specific rates --- */

export interface CustomerPrice {
  id: string
  customerId: string
  customerName: string
  productId: string
  productName: string
  saleUnit: string
  rate: Money
  validFrom: string | null
  validTo: string | null
}

export async function listCustomerPrices(
  db: SqlDriver,
  filter: { customerId?: string; productId?: string } = {},
): Promise<CustomerPrice[]> {
  const where = ['cp.deleted_at IS NULL']
  const args: string[] = []
  if (filter.customerId) { where.push('cp.customer_id = ?'); args.push(filter.customerId) }
  if (filter.productId) { where.push('cp.product_id = ?'); args.push(filter.productId) }

  const rows = await db.query<{
    id: string; customer_id: string; customer_name: string; product_id: string
    product_name: string; sale_unit: string; rate: number
    valid_from: string | null; valid_to: string | null
  }>(
    `SELECT cp.id, cp.customer_id, c.name AS customer_name, cp.product_id, p.name AS product_name,
            cp.sale_unit, cp.rate, cp.valid_from, cp.valid_to
       FROM customer_item_prices cp
       JOIN customers c ON c.id = cp.customer_id
       JOIN products p ON p.id = cp.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name, p.name, cp.sale_unit`,
    args,
  )
  return rows.map((r) => ({
    id: r.id, customerId: r.customer_id, customerName: r.customer_name,
    productId: r.product_id, productName: r.product_name, saleUnit: r.sale_unit,
    rate: r.rate as Money, validFrom: r.valid_from, validTo: r.valid_to,
  }))
}

export async function setCustomerPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: {
    customerId: string; productId: string; saleUnit: string; rate: Money
    validFrom?: string | null; validTo?: string | null
  },
): Promise<ItemPriceResult> {
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    return { ok: false, code: 'BAD_DATES' }
  }
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const existing = await db.get<{ id: string; rate: number }>(
    `SELECT id, rate FROM customer_item_prices WHERE customer_id = ? AND product_id = ? AND sale_unit = ?`,
    [input.customerId, input.productId, input.saleUnit],
  )
  const id = existing?.id ?? newId()

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.execute(
        `UPDATE customer_item_prices SET rate = ?, valid_from = ?, valid_to = ?, deleted_at = NULL,
                                         updated_at = ?, rev = rev + 1
          WHERE id = ?`,
        [input.rate, input.validFrom ?? null, input.validTo ?? null, now, id],
      )
    } else {
      await tx.execute(
        `INSERT INTO customer_item_prices
           (id, customer_id, product_id, sale_unit, rate, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.customerId, input.productId, input.saleUnit, input.rate,
         input.validFrom ?? null, input.validTo ?? null, now, now],
      )
    }
    await writeAudit(tx, ctx, {
      entity: 'customer_item_prices', entityId: id, action: existing ? 'update' : 'create',
      before: existing ? { rate: existing.rate } : null,
      after: { customer_id: input.customerId, product_id: input.productId, rate: input.rate },
    })
  })

  return { ok: true, itemPriceId: id }
}

export async function removeCustomerPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  id: string,
): Promise<void> {
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE customer_item_prices SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [now, now, id],
    )
    await writeAudit(tx, ctx, { entity: 'customer_item_prices', entityId: id, action: 'delete' })
  })
}

/** Which price list a customer buys on. Null puts them back on the default. */
export async function setCustomerPriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  customerId: string,
  priceListId: string | null,
): Promise<void> {
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const before = await db.get<{ price_list_id: string | null }>(
    `SELECT price_list_id FROM customers WHERE id = ?`, [customerId],
  )
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE customers SET price_list_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [priceListId, now, customerId],
    )
    await writeAudit(tx, ctx, {
      entity: 'customers', entityId: customerId, action: 'update',
      before: { price_list_id: before?.price_list_id ?? null },
      after: { price_list_id: priceListId },
    })
  })
}

/* --------------------------------------------------------------- helpers --- */

/**
 * A rate can only be written against a unit the product actually sells in —
 * otherwise it is a price nothing will ever resolve, sitting in the table
 * looking as though it works.
 */
async function unitExists(db: SqlDriver, productId: string, saleUnit: string): Promise<boolean> {
  const base = await db.get<{ base_unit: string }>(
    `SELECT base_unit FROM products WHERE id = ? AND deleted_at IS NULL`, [productId],
  )
  if (!base) return false
  if (base.base_unit === saleUnit) return true
  const row = await db.get<{ id: string }>(
    `SELECT id FROM product_units WHERE product_id = ? AND sale_unit = ?`, [productId, saleUnit],
  )
  return row !== undefined && row !== null
}

/**
 * What one base unit costs at a given rate, for showing a shopkeeper whether a
 * pack of ten is actually cheaper than ten pieces.
 */
export function perBaseUnit(rate: Money, baseUnits: Qty): Money {
  if (baseUnits <= 0) return rate
  return Math.round((rate * QTY_SCALE) / baseUnits) as Money
}
