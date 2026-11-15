import { eq, ne, and, or, desc, isNull, notInArray, inArray, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { derivedId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'
import { isOn } from './features.js'

/**
 * The barcodes an item answers to.
 *
 * One product, several labels: the manufacturer's EAN on the packet, the shop's
 * own printed tag, and the one from the old packaging that is still on the
 * shelves at the back. All three have to find the same item.
 *
 * And since 069, one label on several products: a manufacturer that puts the
 * same EAN on two pack sizes, which the shop keeps as two items. A scan of that
 * code finds both, and the screen asks which -- nothing here picks one for it.
 *
 * `products.barcode` stays as the primary — it is what lists show and what a
 * shelf tag is printed from — and this module is the only place that writes the
 * pair, so the two cannot drift. Everything else reads.
 *
 * A shop that wants every code to mean one item turns on `uniqueBarcode`
 * (`features.ts`): then a code is refused on an item when another has it, in
 * the form (`setBarcodes`) and in a file (`importRowsTakingACode`).
 */

export interface Barcode {
  id: string
  barcode: string
  label: string | null
  isPrimary: boolean
}

export interface BarcodeInput {
  barcode: string
  label?: string | null
}

/** Another item a code is also on, so the screen can say a scan will ask. */
export interface SharedBarcode {
  barcode: string
  productId: string
  productName: string
}

export type SetBarcodesResult =
  | {
      ok: true
      barcodes: Barcode[]
      /** Codes this item now shares, with each other item that has them. Empty for most. */
      shared: SharedBarcode[]
    }
  /** `uniqueBarcode` is on and these codes are already other items'. Nothing was written. */
  | { ok: false; code: 'BARCODE_TAKEN'; taken: SharedBarcode[] }

export async function listBarcodes(db: SqlDriver, productId: string): Promise<Barcode[]> {
  const rows = await q(db)
    .select({
      id: schema.productBarcodes.id,
      barcode: schema.productBarcodes.barcode,
      label: schema.productBarcodes.label,
      isPrimary: schema.productBarcodes.isPrimary,
    })
    .from(schema.productBarcodes)
    .where(and(eq(schema.productBarcodes.productId, productId), isNull(schema.productBarcodes.deletedAt)))
    .orderBy(desc(schema.productBarcodes.isPrimary), schema.productBarcodes.barcode)

  return rows.map((r) => ({ ...r, isPrimary: r.isPrimary === 1 }))
}

/**
 * Replaces the whole set for a product, first entry primary.
 *
 * Rewritten wholesale rather than patched line by line, because the editor hands
 * over a list and a diff of that against the database is a lot of machinery to
 * get an answer the rewrite gives for free.
 *
 * A code another item already has is saved, and named in `shared`. It used to
 * be refused -- a scan that could mean two things was judged worse than one
 * that means nothing -- and a shop with one EAN on two pack sizes could then
 * give only one of them its code. The scan asks instead. With `uniqueBarcode`
 * on it is refused again (`barcodesTaken`), but only a code this item does not
 * already have, so an item that shares one from before can still be saved.
 */
export async function setBarcodes(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productId: string,
  inputs: BarcodeInput[],
): Promise<SetBarcodesResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const cleaned: BarcodeInput[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const code = input.barcode.trim()
    if (code === '' || seen.has(code)) continue
    seen.add(code)
    cleaned.push({ barcode: code, label: input.label?.trim() || null })
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const before = await listBarcodes(db, productId)

  const taken = await barcodesTaken(db, productId, cleaned.map((b) => b.barcode))
  if (taken.length > 0) return { ok: false, code: 'BARCODE_TAKEN', taken }

  await db.transaction(async (tx) => {
    /* Taken off, not deleted (056): a removal is an edit and merges like one,
       where a delete left a tombstone that a third till could outlive -- and a
       barcode brought back that way scans as an item the shop took it off. */
    const keep = cleaned.map((b) => b.barcode)
    await q(tx).update(schema.productBarcodes)
      .set({ deletedAt: now })
      .where(and(
        eq(schema.productBarcodes.productId, productId),
        isNull(schema.productBarcodes.deletedAt),
        ...(keep.length > 0 ? [notInArray(schema.productBarcodes.barcode, keep)] : []),
      ))

    for (const [index, input] of cleaned.entries()) {
      await putBarcode(tx, productId, input.barcode, input.label ?? null, index === 0, now)
    }

    // The pair, written in the one place that owns it.
    await q(tx).update(schema.products)
      .set({
        barcode: cleaned[0]?.barcode ?? null,
        updatedAt: now,
        rev: sql`${schema.products.rev} + 1`,
      })
      .where(eq(schema.products.id, productId))

    await writeAudit(tx, ctx, {
      entity: 'products',
      entityId: productId,
      action: 'update',
      before: { barcodes: before.map((b) => b.barcode).join(', ') || null },
      after: { barcodes: cleaned.map((b) => b.barcode).join(', ') || null },
    })
  })

  return {
    ok: true,
    barcodes: await listBarcodes(db, productId),
    shared: await alsoOn(db, productId, cleaned.map((b) => b.barcode)),
  }
}

/**
 * Puts one barcode on an item as its primary, keeping the others it answers to.
 *
 * For a caller already inside a transaction -- the catalogue import, which
 * plans before it writes. `setBarcodes` replaces the whole set, which from a
 * file that carries one barcode a row would take the old packaging's code off
 * every item in it.
 */
export async function addPrimaryBarcode(
  tx: SqlDriver, productId: string, barcode: string, now: string,
): Promise<void> {
  const code = barcode.trim()
  await q(tx).update(schema.productBarcodes)
    .set({ isPrimary: 0 })
    .where(and(eq(schema.productBarcodes.productId, productId), ne(schema.productBarcodes.barcode, code)))

  await putBarcode(tx, productId, code, undefined, true, now)

  await q(tx).update(schema.products)
    .set({ barcode: code, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
    .where(eq(schema.products.id, productId))
}

/**
 * One code on one item: its row alive again if it had one, else a new one.
 *
 * Found by the item and the code together. Until 069 it was found by the code
 * alone, and a code taken off one item and put on another moved the row --
 * right while a code could only be one item's, and with sharing it would take
 * the code off the item that still has it.
 *
 * A new row's id is derived from the item and the code, so two tills putting
 * one code on one item while apart write one row. Rows from before carry an id
 * derived from the code alone; they are found by what they hold and keep it.
 */
async function putBarcode(
  tx: SqlDriver, productId: string, code: string, label: string | null | undefined,
  primary: boolean, now: string,
): Promise<void> {
  const [held] = await q(tx)
    .select({ id: schema.productBarcodes.id })
    .from(schema.productBarcodes)
    .where(and(eq(schema.productBarcodes.productId, productId), eq(schema.productBarcodes.barcode, code)))
  if (held) {
    await q(tx).update(schema.productBarcodes)
      .set({
        isPrimary: primary ? 1 : 0, deletedAt: null,
        ...(label !== undefined ? { label } : {}),
      })
      .where(eq(schema.productBarcodes.id, held.id))
    return
  }
  await q(tx).insert(schema.productBarcodes).values({
    id: await derivedId('product_barcodes', productId, code),
    productId,
    barcode: code,
    label: label ?? null,
    isPrimary: primary ? 1 : 0,
    createdAt: now,
  })
}

/** The other items each of these codes is on. */
async function alsoOn(db: SqlDriver, productId: string, codes: string[]): Promise<SharedBarcode[]> {
  if (codes.length === 0) return []
  /* The colours of one pen share the pen's code on purpose, and the scan asks
     which colour. A code held only inside the item's own family is not taken. */
  const family = await familyIds(db, productId)
  const rows = await q(db)
    .select({
      barcode: schema.productBarcodes.barcode,
      productId: schema.productBarcodes.productId,
      productName: schema.products.name,
    })
    .from(schema.productBarcodes)
    .innerJoin(schema.products, eq(schema.products.id, schema.productBarcodes.productId))
    .where(and(
      inArray(schema.productBarcodes.barcode, codes),
      ne(schema.productBarcodes.productId, productId),
      isNull(schema.productBarcodes.deletedAt),
      isNull(schema.products.deletedAt),
    ))
    .orderBy(schema.productBarcodes.barcode, schema.products.name)
  return rows.filter((r) => !family.has(r.productId))
}

/** The item, its parent and the parent's other versions. Just the item when it is in no family. */
async function familyIds(db: SqlDriver, productId: string): Promise<Set<string>> {
  if (productId === '') return new Set()
  const [self] = await q(db)
    .select({ parent: schema.products.parentProductId })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  const root = self?.parent ?? productId
  const members = await q(db)
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(or(eq(schema.products.id, root), eq(schema.products.parentProductId, root)), isNull(schema.products.deletedAt)))
  return new Set([productId, ...members.map((m) => m.id)])
}

/**
 * Puts a set of codes on an item inside a caller's transaction, first one
 * primary, without asking about other items: for `addVersions`, which hands
 * the parent's codes to its new colours. Not audited here; the caller audits
 * the item it made.
 */
export async function putBarcodes(
  tx: SqlDriver, productId: string, codes: readonly { barcode: string; label: string | null }[], now: string,
): Promise<void> {
  for (const [index, code] of codes.entries()) {
    await putBarcode(tx, productId, code.barcode, code.label, index === 0, now)
  }
  await q(tx).update(schema.products)
    .set({ barcode: codes[0]?.barcode ?? null, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
    .where(eq(schema.products.id, productId))
}

/** Takes every code off an item inside a caller's transaction: a parent whose codes went to its colours. */
export async function takeOffBarcodes(tx: SqlDriver, productId: string, now: string): Promise<void> {
  await q(tx).update(schema.productBarcodes)
    .set({ deletedAt: now })
    .where(and(eq(schema.productBarcodes.productId, productId), isNull(schema.productBarcodes.deletedAt)))
  await q(tx).update(schema.products)
    .set({ barcode: null, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
    .where(eq(schema.products.id, productId))
}

/**
 * The codes among these that would be refused on this item: empty unless
 * `uniqueBarcode` is on, and then each code another item has that this one
 * does not have already. `productId` is null for an item not saved yet.
 *
 * Exported so a screen can ask before it saves anything, rather than save the
 * item and then be refused its barcodes; `setBarcodes` asks again regardless.
 */
export async function barcodesTaken(
  db: SqlDriver, productId: string | null, codes: readonly string[],
): Promise<SharedBarcode[]> {
  const wanted = [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ''))]
  if (wanted.length === 0 || !(await isOn(db, 'uniqueBarcode'))) return []
  const own = productId === null ? new Set<string>() : new Set((await listBarcodes(db, productId)).map((b) => b.barcode))
  const fresh = wanted.filter((c) => !own.has(c))
  return fresh.length === 0 ? [] : alsoOn(db, productId ?? '', fresh)
}

/** A code on more than one item, and the items: what Settings lists while `uniqueBarcode` is on. */
export interface BarcodeOnSeveral {
  barcode: string
  items: { productId: string; productName: string }[]
}

/** Every code now on more than one item, by code. Empty for most shops. */
export async function sharedBarcodes(db: SqlDriver): Promise<BarcodeOnSeveral[]> {
  const rows = await q(db)
    .select({
      barcode: schema.productBarcodes.barcode,
      productId: schema.productBarcodes.productId,
      productName: schema.products.name,
      root: sql<string>`COALESCE(${schema.products.parentProductId}, ${schema.products.id})`,
    })
    .from(schema.productBarcodes)
    .innerJoin(schema.products, eq(schema.products.id, schema.productBarcodes.productId))
    .where(and(isNull(schema.productBarcodes.deletedAt), isNull(schema.products.deletedAt)))
    .orderBy(schema.productBarcodes.barcode, schema.products.name)
  const byCode = new Map<string, BarcodeOnSeveral & { roots: Set<string> }>()
  for (const r of rows) {
    const entry = byCode.get(r.barcode) ?? { barcode: r.barcode, items: [], roots: new Set<string>() }
    if (!entry.items.some((i) => i.productId === r.productId)) entry.items.push({ productId: r.productId, productName: r.productName })
    entry.roots.add(r.root)
    byCode.set(r.barcode, entry)
  }
  // A code shared only by the colours of one item is meant (`addVersions`), not a muddle to sort out.
  return [...byCode.values()]
    .filter((e) => e.items.length > 1 && e.roots.size > 1)
    .map(({ barcode, items }) => ({ barcode, items }))
}

/**
 * Rows of a catalogue file that would put a code on a second item while
 * `uniqueBarcode` is on, by `key`: a new item with a code the shop already
 * has, an item given a code another has, or a code the file has already given
 * to an earlier row's item. The first row to claim a code keeps it. Rows
 * already refused for something else are not passed in. `services/import.ts`
 * turns these into `BARCODE_TAKEN`.
 */
export async function importRowsTakingACode(db: SqlDriver, rows: readonly {
  key: number; productId: string | null; barcode: string | null
  /** The family the row is a variant of, by name: its variants share one code on purpose. */
  family?: string | null
}[]): Promise<Set<number>> {
  const refused = new Set<number>()
  const coded = rows.filter((r) => r.barcode !== null && r.barcode.trim() !== '')
  if (coded.length === 0 || !(await isOn(db, 'uniqueBarcode'))) return refused
  const claimed = new Map<string, string>()
  for (const row of [...coded].sort((a, b) => a.key - b.key)) {
    const code = row.barcode!.trim()
    // A family claims a code as one: the XO pen's colours are one owner of the pen's code.
    const who = row.family ? `family:${row.family.trim().toLowerCase()}` : row.productId ?? `new:${row.key}`
    const first = claimed.get(code)
    if (first !== undefined && first !== who) { refused.add(row.key); continue }
    const kin = new Set([...(row.productId ? await familyIds(db, row.productId) : []), ...(row.family ? await familyNamed(db, row.family) : [])])
    const holders = await productIdsForBarcode(db, code)
    if (holders.some((id) => id !== row.productId && !kin.has(id))) { refused.add(row.key); continue }
    claimed.set(code, who)
  }
  return refused
}

/** The item called this, with no family of its own, and its variants: a family named in a file. */
async function familyNamed(db: SqlDriver, name: string): Promise<string[]> {
  // raw: a case-blind match on the name, and its variants by the same row, which the builder has no word for
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM products WHERE deleted_at IS NULL AND (
       (parent_product_id IS NULL AND lower(trim(name)) = lower(trim(?)))
       OR parent_product_id IN (SELECT id FROM products WHERE parent_product_id IS NULL AND lower(trim(name)) = lower(trim(?))))`,
    [name, name],
  )
  return rows.map((r) => r.id)
}

/** Every item a scan could mean. Empty for a code the shop does not have. */
export async function productIdsForBarcode(db: SqlDriver, barcode: string): Promise<string[]> {
  const rows = await q(db)
    .selectDistinct({ productId: schema.productBarcodes.productId })
    .from(schema.productBarcodes)
    .innerJoin(schema.products, eq(schema.products.id, schema.productBarcodes.productId))
    .where(and(
      eq(schema.productBarcodes.barcode, barcode.trim()),
      isNull(schema.productBarcodes.deletedAt),
      isNull(schema.products.deletedAt),
    ))
  return rows.map((r) => r.productId)
}

/**
 * The product a scan means, when it means exactly one.
 *
 * Null for a code nobody has and for a code several items share: a caller that
 * needs an id cannot be handed one of two, and one that can ask the person
 * asks `productIdsForBarcode`. Kept beside `findByBarcode` in the catalog repo:
 * this answers the id, that the whole row the counter needs.
 */
export async function productIdForBarcode(db: SqlDriver, barcode: string): Promise<string | null> {
  const ids = await productIdsForBarcode(db, barcode)
  return ids.length === 1 ? ids[0]! : null
}
