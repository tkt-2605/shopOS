import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import type { Money } from '../money.js'
import { type Qty, qty, QTY_SCALE } from '../quantity.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import type { Rung } from '../domain/ladder.js'

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
  /** Taken off the list of lists. See `archivePriceList`. */
  archived: boolean
  /** How many customers are on this list, so archiving one is an informed act. */
  customerCount: number
  priceCount: number
}

export async function listPriceLists(
  db: SqlDriver,
  options: { includeArchived?: boolean } = {},
): Promise<PriceList[]> {
  const rows = await db.query<{
    id: string; name: string; is_default: number; deleted_at: string | null
    customers: number; prices: number
  }>(
    `SELECT l.id, l.name, l.is_default, l.deleted_at,
            (SELECT COUNT(*) FROM customers c WHERE c.price_list_id = l.id AND c.deleted_at IS NULL) AS customers,
            (SELECT COUNT(*) FROM item_prices p WHERE p.price_list_id = l.id AND p.deleted_at IS NULL) AS prices
       FROM price_lists l
      WHERE ${options.includeArchived ? '1 = 1' : 'l.deleted_at IS NULL'}
      ORDER BY l.deleted_at IS NOT NULL, l.is_default DESC, l.name`,
  )
  return rows.map((r) => ({
    id: r.id, name: r.name, isDefault: r.is_default === 1, archived: r.deleted_at !== null,
    customerCount: r.customers, priceCount: r.prices,
  }))
}

export type PriceListResult =
  | { ok: true; priceListId: string }
  | { ok: false; code: 'NO_NAME' }
  | { ok: false; code: 'NAME_TAKEN' }
  /* The name is UNIQUE in the schema and an archived list keeps its row, so
     "Wholesale" stays spoken for after it is taken off the list. Saying which
     kind of clash it is lets the screen offer the one useful answer -- bring
     the old one back -- instead of a shopkeeper typing Wholesale2. */
  | { ok: false; code: 'NAME_TAKEN_ARCHIVED'; priceListId: string }

export async function createPriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { name: string; isDefault?: boolean },
): Promise<PriceListResult> {
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }
  const taken = await db.get<{ id: string; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM price_lists WHERE name = ? COLLATE NOCASE`, [name],
  )
  if (taken) {
    return taken.deleted_at === null
      ? { ok: false, code: 'NAME_TAKEN' }
      : { ok: false, code: 'NAME_TAKEN_ARCHIVED', priceListId: taken.id }
  }

  const id = newId()
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    // One default, always: a shop with two has no answer for a walk-in customer.
    if (input.isDefault) await tx.execute(`UPDATE price_lists SET is_default = 0`)
    await tx.execute(
      `INSERT INTO price_lists (id, name, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
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
  const before = await db.get<{ name: string; is_default: number }>(
    `SELECT name, is_default FROM price_lists WHERE id = ? AND deleted_at IS NULL`,
    [input.priceListId],
  )
  if (!before) throw new Error('no such price list')

  const name = input.name?.trim() ?? before.name
  if (name === '') return { ok: false, code: 'NO_NAME' }
  if (name !== before.name) {
    const taken = await db.get<{ id: string; deleted_at: string | null }>(
      `SELECT id, deleted_at FROM price_lists WHERE name = ? COLLATE NOCASE AND id <> ?`,
      [name, input.priceListId],
    )
    if (taken) {
      return taken.deleted_at === null
        ? { ok: false, code: 'NAME_TAKEN' }
        : { ok: false, code: 'NAME_TAKEN_ARCHIVED', priceListId: taken.id }
    }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const isDefault = input.isDefault ?? before.is_default === 1

  await db.transaction(async (tx) => {
    if (isDefault) await tx.execute(`UPDATE price_lists SET is_default = 0`)
    await tx.execute(
      `UPDATE price_lists SET name = ?, is_default = ?, updated_at = ?, rev = rev + 1
        WHERE id = ?`,
      [name, isDefault ? 1 : 0, now, input.priceListId],
    )
    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: input.priceListId, action: 'update',
      before: { name: before.name, is_default: before.is_default },
      after: { name, is_default: isDefault ? 1 : 0 },
    })
  })

  return { ok: true, priceListId: input.priceListId }
}

export type ArchivePriceListResult =
  | { ok: true }
  /* The default list. Archiving it leaves a walk-in customer with no list at
     all, and `idx_price_lists_one_default` would go on holding the default
     slot for a row nothing can see. Make another one default first. */
  | { ok: false; code: 'IS_DEFAULT' }
  /* Customers buy on this list. Hiding it does not move them off it -- it
     changes what they are charged, quietly, at the counter, tomorrow morning.
     That is a decision about prices, and it belongs to the shop, one customer
     at a time, on the screen that shows who they are. */
  | { ok: false; code: 'IN_USE'; customerCount: number }

/**
 * Taking a price list off the list of price lists.
 *
 * `deleted_at` on this table has been filtered by every reader since 001 --
 * `listPriceLists`, `createPriceList`, `defaultPriceListId` -- and set by
 * nothing. So a list typed in by mistake, or one for a scheme that ended two
 * Diwalis ago, stayed on the screen for the life of the shop. This is the
 * writing half those readers were waiting for.
 *
 * It is a soft delete and it has to be. `item_prices` rows point at the list,
 * and a submitted bill line points at the `item_prices` row it was priced from
 * through `price_source_id` -- that chain is how support answers "why was this
 * one 42 rupees last March", and a hard delete breaks it at the first link.
 *
 * Archiving takes the rates out of use without taking them out of the record:
 * `pricingContextFor` will not price a customer on an archived list, and the
 * list stops appearing anywhere a live list belongs.
 */
export async function archivePriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  priceListId: string,
): Promise<ArchivePriceListResult> {
  const list = await db.get<{ is_default: number }>(
    `SELECT is_default FROM price_lists WHERE id = ? AND deleted_at IS NULL`, [priceListId],
  )
  if (!list) throw new Error('no such price list')
  if (list.is_default === 1) return { ok: false, code: 'IS_DEFAULT' }

  const on = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM customers WHERE price_list_id = ? AND deleted_at IS NULL`,
    [priceListId],
  )
  if ((on?.n ?? 0) > 0) return { ok: false, code: 'IN_USE', customerCount: on?.n ?? 0 }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE price_lists SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, priceListId],
    )
    await writeAudit(tx, ctx, { entity: 'price_lists', entityId: priceListId, action: 'delete' })
  })

  return { ok: true }
}

/**
 * And back.
 *
 * The rates on it were never touched, so the list resumes pricing exactly as it
 * did. That is the reason a shop can afford to archive one at all.
 */
export async function restorePriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  priceListId: string,
): Promise<void> {
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE price_lists SET deleted_at = NULL, updated_at = ? WHERE id = ?`, [now, priceListId],
    )
    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: priceListId, action: 'update',
      before: { 'On the list': 'removed' }, after: { 'On the list': 'yes' },
    })
  })
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
  /** A customer's own rate is a ladder too: ₹9, ₹8 from ten, ₹7 from fifty. */
  minQty: Qty
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
    product_name: string; sale_unit: string; min_qty: number; rate: number
    valid_from: string | null; valid_to: string | null
  }>(
    `SELECT cp.id, cp.customer_id, c.name AS customer_name, cp.product_id, p.name AS product_name,
            cp.sale_unit, cp.min_qty, cp.rate, cp.valid_from, cp.valid_to
       FROM customer_item_prices cp
       JOIN customers c ON c.id = cp.customer_id
       JOIN products p ON p.id = cp.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name, p.name, cp.sale_unit, cp.min_qty`,
    args,
  )
  return rows.map((r) => ({
    id: r.id, customerId: r.customer_id, customerName: r.customer_name,
    productId: r.product_id, productName: r.product_name, saleUnit: r.sale_unit,
    minQty: qty(r.min_qty), rate: r.rate as Money, validFrom: r.valid_from, validTo: r.valid_to,
  }))
}

export async function setCustomerPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: {
    customerId: string; productId: string; saleUnit: string; rate: Money
    minQty?: Qty; validFrom?: string | null; validTo?: string | null
  },
): Promise<ItemPriceResult> {
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    return { ok: false, code: 'BAD_DATES' }
  }
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const minQty = input.minQty ?? qty(0)
  const existing = await db.get<{ id: string; rate: number }>(
    `SELECT id, rate FROM customer_item_prices
      WHERE customer_id = ? AND product_id = ? AND sale_unit = ? AND min_qty = ?`,
    [input.customerId, input.productId, input.saleUnit, minQty],
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
           (id, customer_id, product_id, sale_unit, min_qty, rate, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.customerId, input.productId, input.saleUnit, minQty, input.rate,
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

/* --------------------------------------------------------------- ladders --- */

export type SetLadderResult =
  | { ok: true; rungs: number; removed: number }
  | { ok: false; code: 'UNKNOWN_UNIT'; saleUnit: string }
  | { ok: false; code: 'BAD_DATES' }

/**
 * A whole quantity ladder in one go.
 *
 * The rungs given become the ladder: anything at a quantity not in the list is
 * removed. That is what makes the compact form on the product screen honest —
 * what is typed there is the ladder, not an addition to whatever was there
 * before, which would leave a rung nobody can see quietly undercutting the rest.
 */
export async function setLadder(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; priceListId: string; saleUnit: string; rungs: Rung[] },
): Promise<SetLadderResult> {
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

  const existing = await db.query<{ id: string; min_qty: number }>(
    `SELECT id, min_qty FROM item_prices
      WHERE product_id = ? AND price_list_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
    [input.productId, input.priceListId, input.saleUnit],
  )
  const keep = new Set<number>(input.rungs.map((r) => r.minQty))

  for (const rung of input.rungs) {
    const written = await setItemPrice(db, ctx, {
      productId: input.productId,
      priceListId: input.priceListId,
      saleUnit: input.saleUnit,
      minQty: rung.minQty,
      rate: rung.rate,
    })
    if (!written.ok) return written
  }

  for (const row of existing) {
    if (!keep.has(row.min_qty)) await removeItemPrice(db, ctx, row.id)
  }

  return { ok: true, rungs: input.rungs.length, removed: existing.filter((r) => !keep.has(r.min_qty)).length }
}

/** The same, for a rate that belongs to one customer and one item. */
export async function setCustomerLadder(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { customerId: string; productId: string; saleUnit: string; rungs: Rung[] },
): Promise<SetLadderResult> {
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

  const existing = await db.query<{ id: string; min_qty: number }>(
    `SELECT id, min_qty FROM customer_item_prices
      WHERE customer_id = ? AND product_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
    [input.customerId, input.productId, input.saleUnit],
  )
  const keep = new Set<number>(input.rungs.map((r) => r.minQty))

  for (const rung of input.rungs) {
    const written = await setCustomerPrice(db, ctx, {
      customerId: input.customerId,
      productId: input.productId,
      saleUnit: input.saleUnit,
      minQty: rung.minQty,
      rate: rung.rate,
    })
    if (!written.ok) return written
  }

  for (const row of existing) {
    if (!keep.has(row.min_qty)) await removeCustomerPrice(db, ctx, row.id)
  }

  return { ok: true, rungs: input.rungs.length, removed: existing.filter((r) => !keep.has(r.min_qty)).length }
}

/** One product's ladder on one list, in the order it applies. */
export async function ladderFor(
  db: SqlDriver,
  input: { productId: string; priceListId: string; saleUnit: string },
): Promise<Rung[]> {
  const rows = await db.query<{ min_qty: number; rate: number }>(
    `SELECT min_qty, rate FROM item_prices
      WHERE product_id = ? AND price_list_id = ? AND sale_unit = ? AND deleted_at IS NULL
      ORDER BY min_qty`,
    [input.productId, input.priceListId, input.saleUnit],
  )
  return rows.map((r) => ({ minQty: qty(r.min_qty), rate: r.rate as Money }))
}

export async function customerLadderFor(
  db: SqlDriver,
  input: { customerId: string; productId: string; saleUnit: string },
): Promise<Rung[]> {
  const rows = await db.query<{ min_qty: number; rate: number }>(
    `SELECT min_qty, rate FROM customer_item_prices
      WHERE customer_id = ? AND product_id = ? AND sale_unit = ? AND deleted_at IS NULL
      ORDER BY min_qty`,
    [input.customerId, input.productId, input.saleUnit],
  )
  return rows.map((r) => ({ minQty: qty(r.min_qty), rate: r.rate as Money }))
}

/**
 * Every product's ladder on one list, for a column in a list of products.
 *
 * One query rather than one per row: a shop with three thousand items would
 * otherwise open its product screen three thousand times.
 */
export async function laddersFor(
  db: SqlDriver,
  priceListId: string,
): Promise<Map<string, Rung[]>> {
  const rows = await db.query<{ product_id: string; sale_unit: string; min_qty: number; rate: number }>(
    `SELECT ip.product_id, ip.sale_unit, ip.min_qty, ip.rate
       FROM item_prices ip
       JOIN products p ON p.id = ip.product_id
      WHERE ip.price_list_id = ? AND ip.deleted_at IS NULL AND ip.sale_unit = p.base_unit
      ORDER BY ip.product_id, ip.min_qty`,
    [priceListId],
  )

  const ladders = new Map<string, Rung[]>()
  for (const row of rows) {
    const rungs = ladders.get(row.product_id) ?? []
    rungs.push({ minQty: qty(row.min_qty), rate: row.rate as Money })
    ladders.set(row.product_id, rungs)
  }
  return ladders
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
