import { eq, and, isNull, isNotNull, asc, sql, count } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'
import type { Qty } from '../quantity.js'
import type { Money } from '../money.js'
import { productsByIds, type ProductListItem } from '../repos/catalog/products.js'
import { listBarcodes, putBarcodes, takeOffBarcodes } from './barcodes.js'
import { createStockEntry, submitStockEntry } from './stockEntry.js'
import { stockValue } from './stock.js'
import { allOrNothing } from './allOrNothing.js'

/**
 * One item in several versions: the XO pen in blue, black and red.
 *
 * `grouping.ts` holds the link -- a version names its parent and carries a
 * label -- and the reason each colour is its own product: six colours on the
 * shelf are six stock counts. This file is what makes that usable at a shop
 * whose colours all carry the pen's one barcode:
 *
 * - **Adding colours** makes each one from the parent in one step, with the
 *   parent's price, tax, units and barcodes, and takes the codes off the
 *   parent. A scan then finds only colours and asks which.
 * - **The parent becomes the family's name.** It is not sold (`price.ts`
 *   refuses it on a bill); picking it at the counter opens the colour box. The
 *   pens it held before it had colours stay on it until they are split.
 * - **One price for the family** is a switch on the parent (085). On, each
 *   save of the parent or of a colour leaves every colour at the parent's
 *   price, tax and cost; off, each colour is priced on its own.
 */

/** What the colours of a family take from it while `family_price` is on. */
const SHARED = {
  baseRate: schema.products.baseRate,
  mrp: schema.products.mrp,
  taxRateBp: schema.products.taxRateBp,
  cessRateBp: schema.products.cessRateBp,
  hsnCode: schema.products.hsnCode,
  openPrice: schema.products.openPrice,
  costPrice: schema.products.costPrice,
  costPriceAt: schema.products.costPriceAt,
  discountBlocked: schema.products.discountBlocked,
  loyaltyBlocked: schema.products.loyaltyBlocked,
  returnBlocked: schema.products.returnBlocked,
}

export type AddVersionsResult =
  | { ok: true; created: { id: string; label: string }[] }
  | { ok: false; code: 'NO_LABELS' }
  /** A colour of something cannot have colours of its own: one level only (`setVariantOf`). */
  | { ok: false; code: 'IS_A_VERSION' }
  | { ok: false; code: 'LABEL_TAKEN'; label: string }

/**
 * Makes a version of `parentId` for each label, in one transaction.
 *
 * Each is named after the parent with its label, "XO pen (Blue)", because the
 * name is what a bill line keeps (`bill_items.product_name`) and a receipt
 * that says "XO pen" three times cannot be read back. The first colours an
 * item is given turn its family price on; it can be turned off afterwards.
 */
export async function addVersions(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { parentId: string; labels: readonly string[] },
): Promise<AddVersionsResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const labels: string[] = []
  for (const raw of input.labels) {
    const label = raw.trim()
    if (label !== '' && !labels.some((l) => l.toLowerCase() === label.toLowerCase())) labels.push(label)
  }
  if (labels.length === 0) return { ok: false, code: 'NO_LABELS' }

  const [parent] = await q(db).select().from(schema.products)
    .where(and(eq(schema.products.id, input.parentId), isNull(schema.products.deletedAt)))
  if (!parent) throw new Error(`unknown product: ${input.parentId}`)
  if (parent.parentProductId !== null) return { ok: false, code: 'IS_A_VERSION' }

  const existing = await versionRows(db, parent.id)
  const clash = labels.find((l) => existing.some((v) => (v.variantLabel ?? '').toLowerCase() === l.toLowerCase()))
  if (clash !== undefined) return { ok: false, code: 'LABEL_TAKEN', label: clash }

  const codes = (await listBarcodes(db, parent.id)).map((b) => ({ barcode: b.barcode, label: b.label }))
  const units = await q(db).select().from(schema.productUnits)
    .where(and(eq(schema.productUnits.productId, parent.id), isNull(schema.productUnits.deletedAt)))
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  return db.transaction(async (tx) => {
    const created: { id: string; label: string }[] = []
    for (const label of labels) {
      const id = newId()
      const { id: _id, code: _code, barcode: _barcode, rev: _rev, originId: _origin, familyPrice: _family,
        reorderLevel: _level, reorderQty: _qty, ...copied } = parent
      await q(tx).insert(schema.products).values({
        ...copied, id, name: versionName(parent.name, label), parentProductId: parent.id, variantLabel: label,
        createdAt: now, updatedAt: now, deletedAt: null,
      })
      for (const unit of units) {
        await q(tx).insert(schema.productUnits).values({
          id: newId(), productId: id, saleUnit: unit.saleUnit, baseUnits: unit.baseUnits,
          isDefault: unit.isDefault, mrp: unit.mrp, createdAt: now, updatedAt: now,
        })
      }
      if (codes.length > 0) await putBarcodes(tx, id, codes, now)
      await writeAudit(tx, ctx, {
        entity: 'products', entityId: id, action: 'create',
        after: { name: versionName(parent.name, label), version_of: parent.id, variant_label: label, base_rate: parent.baseRate },
      })
      created.push({ id, label })
    }

    // The parent is the family's name from here on: its codes go to the colours, so a scan asks which.
    if (codes.length > 0) await takeOffBarcodes(tx, parent.id, now)
    if (existing.length === 0) {
      await q(tx).update(schema.products)
        .set({ familyPrice: 1, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
        .where(eq(schema.products.id, parent.id))
    }
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: parent.id, action: 'update',
      before: { barcodes: codes.map((c) => c.barcode).join(', ') || null },
      after: { versions_added: labels.join(', '), barcodes: null, ...(existing.length === 0 ? { family_price: 1 } : {}) },
    })
    return { ok: true as const, created }
  })
}

/**
 * Turns the family's one price on or off. On, the colours take the parent's
 * price at once, so the switch never says one thing while the shelf says another.
 */
export async function setFamilyPrice(
  db: SqlDriver, ctx: AuditContext & { actorId: string }, parentId: string, on: boolean,
): Promise<void> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.products)
      .set({ familyPrice: on ? 1 : 0, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
      .where(eq(schema.products.id, parentId))
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: parentId, action: 'update', before: null, after: { family_price: on ? 1 : 0 },
    })
    if (on) await followFamily(tx, ctx, parentId)
  })
}

/**
 * After an item is saved: when it is in a family priced as one, every colour
 * is left at the parent's price. A saved parent hands its price down; a saved
 * colour is put back to the parent's, so one colour cannot drift on its own
 * while the family says it is priced as one. Called inside the save's
 * transaction (`saveProductDetails`).
 */
export async function followFamily(tx: SqlDriver, ctx: AuditContext, productId: string): Promise<void> {
  const [self] = await q(tx)
    .select({ parent: schema.products.parentProductId })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (!self) return
  const rootId = self.parent ?? productId
  const [root] = await q(tx).select({ familyPrice: schema.products.familyPrice, name: schema.products.name, ...SHARED })
    .from(schema.products).where(eq(schema.products.id, rootId))
  if (!root) return
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  /* A variant's name is its family's with its label, whatever the price
     switch says: renaming the pen renames every colour, so a bill line never
     names a family that is no longer called that. */
  for (const version of await versionRows(tx, rootId)) {
    const [row] = await q(tx).select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, version.id))
    const named = versionName(root.name, version.variantLabel ?? '')
    if (!row || row.name === named) continue
    await q(tx).update(schema.products)
      .set({ name: named, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
      .where(eq(schema.products.id, version.id))
    await writeAudit(tx, ctx, { entity: 'products', entityId: version.id, action: 'update', before: { name: row.name }, after: { name: named } })
  }

  if (root.familyPrice !== 1) return
  const { familyPrice: _f, name: _n, ...price } = root
  for (const version of await versionRows(tx, rootId)) {
    const [was] = await q(tx).select(SHARED).from(schema.products).where(eq(schema.products.id, version.id))
    if (!was || (Object.keys(price) as (keyof typeof price)[]).every((k) => was[k] === price[k])) continue
    await q(tx).update(schema.products)
      .set({ ...price, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
      .where(eq(schema.products.id, version.id))
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: version.id, action: 'update',
      before: { base_rate: was.baseRate, mrp: was.mrp, tax_rate_bp: was.taxRateBp },
      after: { base_rate: price.baseRate, mrp: price.mrp, tax_rate_bp: price.taxRateBp, follows: rootId },
    })
  }
}

/** Whether a parent's colours take its price (085). False for an item with no colours. */
export async function familyPriced(db: SqlDriver, parentId: string): Promise<boolean> {
  const [row] = await q(db).select({ familyPrice: schema.products.familyPrice })
    .from(schema.products).where(eq(schema.products.id, parentId))
  return row?.familyPrice === 1
}

/**
 * A family's variants, in label order, as the counter lists items. Only those
 * in use unless asked: the counter's box offers nothing taken out of use, the
 * family's own page lists every one so it can be put back.
 */
export async function familyVersions(
  db: SqlDriver, parentId: string, { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<ProductListItem[]> {
  const ids = (await versionRows(db, parentId)).map((v) => v.id)
  const items = await productsByIds(db, ids)
  return ids.map((id) => items.find((p) => p.id === id))
    .filter((p): p is ProductListItem => p !== undefined && (includeRetired || p.isActive))
}

/**
 * Every family's variants in use and the stock they hold together, by family:
 * what the Inventory list shows on a family's row, whichever of its variants a
 * search happened to find.
 */
export async function familyTotals(db: SqlDriver): Promise<Map<string, { count: number; qty: Qty }>> {
  const rows = await q(db)
    .select({
      parent: schema.products.parentProductId,
      count: count(),
      qty: sql<Qty>`COALESCE(SUM(${schema.productStock.qtyOnHand}), 0)`,
    })
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .where(and(isNotNull(schema.products.parentProductId), isNull(schema.products.deletedAt), eq(schema.products.isActive, 1)))
    .groupBy(schema.products.parentProductId)
  return new Map(rows.map((r) => [r.parent!, { count: r.count, qty: r.qty }]))
}

/** What a variant is called: its family's name with its label, "XO pen (Blue)". */
export function versionName(familyName: string, label: string): string {
  return `${familyName} (${label})`
}

export type EditVersionResult =
  | { ok: true }
  | { ok: false; code: 'NOT_A_VERSION' | 'NO_LABEL' | 'BAD_RATE' }
  | { ok: false; code: 'LABEL_TAKEN'; label: string }
  /** Its price is the family's while the family is priced as one. */
  | { ok: false; code: 'FAMILY_PRICED' }

/**
 * One variant changed from its family's table: its label (and with it its
 * name), its own price when the family is not priced as one, and whether it
 * is in use. Its barcodes go through `setBarcodes` like any item's.
 */
export async function editVersion(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; label?: string; baseRate?: Money; active?: boolean },
): Promise<EditVersionResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const [self] = await q(db).select({
    parent: schema.products.parentProductId, label: schema.products.variantLabel,
    baseRate: schema.products.baseRate, isActive: schema.products.isActive, name: schema.products.name,
  }).from(schema.products).where(and(eq(schema.products.id, input.productId), isNull(schema.products.deletedAt)))
  if (!self?.parent) return { ok: false, code: 'NOT_A_VERSION' }
  const [family] = await q(db).select({ name: schema.products.name, familyPrice: schema.products.familyPrice })
    .from(schema.products).where(eq(schema.products.id, self.parent))

  const before: Record<string, string | number | null> = {}
  const after: Record<string, string | number | null> = {}
  const set: Partial<{ variantLabel: string; name: string; baseRate: Money; isActive: number }> = {}

  if (input.label !== undefined && input.label.trim() !== self.label) {
    const label = input.label.trim()
    if (label === '') return { ok: false, code: 'NO_LABEL' }
    const siblings = await versionRows(db, self.parent)
    if (siblings.some((v) => v.id !== input.productId && (v.variantLabel ?? '').toLowerCase() === label.toLowerCase())) {
      return { ok: false, code: 'LABEL_TAKEN', label }
    }
    set.variantLabel = label
    set.name = versionName(family?.name ?? self.name, label)
    before.variant_label = self.label; after.variant_label = label
  }
  if (input.baseRate !== undefined && input.baseRate !== self.baseRate) {
    if (family?.familyPrice === 1) return { ok: false, code: 'FAMILY_PRICED' }
    if (!Number.isInteger(input.baseRate) || input.baseRate < 0) return { ok: false, code: 'BAD_RATE' }
    set.baseRate = input.baseRate
    before.base_rate = self.baseRate; after.base_rate = input.baseRate
  }
  if (input.active !== undefined && (self.isActive === 1) !== input.active) {
    set.isActive = input.active ? 1 : 0
    before.is_active = self.isActive; after.is_active = set.isActive
  }
  if (Object.keys(set).length === 0) return { ok: true }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.products)
      .set({ ...set, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
      .where(eq(schema.products.id, input.productId))
    await writeAudit(tx, ctx, { entity: 'products', entityId: input.productId, action: 'update', before, after })
  })
  return { ok: true }
}

export type SplitResult =
  | { ok: true; entryId: string; docNo: string }
  | { ok: false; code: 'NO_LINES' | 'NOT_A_VERSION' | 'MORE_THAN_HELD' }
  | { ok: false; code: 'COULD_NOT_POST'; detail: string }

/**
 * Moves the pens a parent held before it had colours onto the colours.
 *
 * One adjustment: the parent down by the total, each colour up by its share,
 * every colour at the parent's own unit cost. The stock's value is carried
 * across rather than re-priced, so the books do not move because pens were
 * sorted by colour -- to the paisa a unit cost can be rounded to.
 */
export async function splitIntoVersions(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { parentId: string; lines: readonly { productId: string; qty: Qty }[] },
): Promise<SplitResult> {
  await requirePermission(db, ctx.actorId, 'stock_entry', 'submit')
  const lines = input.lines.filter((l) => l.qty > 0)
  if (lines.length === 0) return { ok: false, code: 'NO_LINES' }
  const versions = new Set((await versionRows(db, input.parentId)).map((v) => v.id))
  if (lines.some((l) => !versions.has(l.productId))) return { ok: false, code: 'NOT_A_VERSION' }

  const held = await stockValue(db, input.parentId)
  const total = lines.reduce((sum, l) => sum + l.qty, 0) as Qty
  if (total > held.qty) return { ok: false, code: 'MORE_THAN_HELD' }
  const unitCost = held.unitCost ?? undefined

  /* The entry raised and posted in one transaction: a refusal at posting
     used to leave the adjustment behind as a draft nobody asked for. */
  return allOrNothing<SplitResult>(db, async (tx, refuse) => {
    const made = await createStockEntry(tx, {
      entryType: 'adjustment',
      reference: 'Split into variants',
      notes: 'Stock held before the item had variants, moved onto them at its own cost.',
      lines: [
        { productId: input.parentId, qty: -total as Qty },
        ...lines.map((l) => ({ productId: l.productId, qty: l.qty, ...(unitCost !== undefined ? { unitCost } : {}) })),
      ],
      actorId: ctx.actorId,
    })
    if (!made.ok) return refuse({ ok: false, code: 'COULD_NOT_POST', detail: made.code })
    const posted = await submitStockEntry(tx, { entryId: made.entryId, actorId: ctx.actorId })
    if (!posted.ok) return refuse({ ok: false, code: 'COULD_NOT_POST', detail: posted.code })
    return { ok: true, entryId: posted.entryId, docNo: posted.docNo }
  })
}

async function versionRows(db: SqlDriver, parentId: string): Promise<{ id: string; variantLabel: string | null }[]> {
  return q(db)
    .select({ id: schema.products.id, variantLabel: schema.products.variantLabel })
    .from(schema.products)
    .where(and(eq(schema.products.parentProductId, parentId), isNull(schema.products.deletedAt)))
    // Blue before black before Red, as a person reads a list, not as bytes sort.
    .orderBy(sql`${schema.products.variantLabel} COLLATE NOCASE`, asc(schema.products.name))
}
