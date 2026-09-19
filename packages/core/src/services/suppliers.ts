import { eq, ne, and, isNull, isNotNull, desc, count, max, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'
import { SUBMITTED } from '../integrity/docstatus.js'

/**
 * Who the shop buys from.
 *
 * A supplier is a record rather than a name typed onto each receipt, because a
 * typed name becomes "Sakthi Agencies", "sakthi agency" and "Sakthi" inside a
 * month, and then no purchase history joins up — which is the same thing as not
 * having one.
 */

export interface Supplier {
  id: string
  name: string
  phone: string | null
  gstin: string | null
  address: string | null
  isActive: boolean
}

export interface SupplierSummary extends Supplier {
  entryCount: number
  lastPurchase: string | null
  purchased: Money
  /** Off the list entirely, as against `isActive`, which is "not just now". */
  archived: boolean
}

/** The five columns both lists return. */
const supplierShape = {
  id: schema.suppliers.id,
  name: schema.suppliers.name,
  phone: schema.suppliers.phone,
  gstin: schema.suppliers.gstin,
  address: schema.suppliers.address,
  isActive: schema.suppliers.isActive,
}

export async function listSuppliers(db: SqlDriver, includeInactive = false): Promise<Supplier[]> {
  const rows = await q(db)
    .select(supplierShape)
    .from(schema.suppliers)
    .where(and(
      isNull(schema.suppliers.deletedAt),
      ...(includeInactive ? [] : [eq(schema.suppliers.isActive, 1)]),
    ))
    .orderBy(schema.suppliers.name)
  return rows.map(toSupplier)
}

/** The list with what has actually been bought, for the suppliers screen. */
export async function supplierSummaries(
  db: SqlDriver,
  opts: { includeArchived?: boolean } = {},
): Promise<SupplierSummary[]> {
  const rows = await q(db)
    .select({
      ...supplierShape,
      deletedAt: schema.suppliers.deletedAt,
      entryCount: count(schema.stockEntries.id),
      lastPurchase: max(schema.stockEntries.postingDate),
      /* raw: what each entry came to, summed across the entries. It is a
         subquery rather than a second join because the entries are already
         joined and grouped -- joining the lines as well would multiply the
         count of entries by the number of lines on each. `stock_entries.id` is
         written out because inside the subquery a bare `id` would bind to
         `stock_entry_items`. */
      purchased: sql<Money>`COALESCE(SUM((
        SELECT COALESCE(SUM(CAST(ROUND(i.qty * i.unit_cost / 10000.0) AS INTEGER)), 0)
          FROM stock_entry_items i WHERE i.entry_id = stock_entries.id)), 0)`,
    })
    .from(schema.suppliers)
    .leftJoin(schema.stockEntries, and(
      eq(schema.stockEntries.supplierId, schema.suppliers.id),
      eq(schema.stockEntries.docstatus, SUBMITTED),
    ))
    .where(and(...(opts.includeArchived ? [] : [isNull(schema.suppliers.deletedAt)])))
    .groupBy(schema.suppliers.id)
    .orderBy(schema.suppliers.name)

  return rows.map((r) => ({
    ...toSupplier(r),
    entryCount: r.entryCount,
    lastPurchase: r.lastPurchase,
    purchased: r.purchased,
    archived: r.deletedAt !== null,
  }))
}

export type SupplierResult =
  | { ok: true; supplierId: string }
  | { ok: false; code: 'NAME_TAKEN' }
  | { ok: false; code: 'NO_NAME' }

export async function createSupplier(
  db: SqlDriver,
  input: { name: string; phone?: string; gstin?: string; address?: string; actorId: string },
): Promise<SupplierResult> {
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }
  if (await nameTaken(db, name)) return { ok: false, code: 'NAME_TAKEN' }

  const id = newId()
  const now = new Date().toISOString()

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.suppliers).values({
      id,
      name,
      phone: blank(input.phone),
      gstin: blank(input.gstin),
      address: blank(input.address),
      createdAt: now,
      updatedAt: now,
    })
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'suppliers', entityId: id, action: 'create', after: { name },
    })
  })

  return { ok: true, supplierId: id }
}

export async function updateSupplier(
  db: SqlDriver,
  input: {
    supplierId: string; name: string; phone?: string; gstin?: string
    address?: string; isActive?: boolean; actorId: string
  },
): Promise<SupplierResult> {
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }
  if (await nameTaken(db, name, input.supplierId)) return { ok: false, code: 'NAME_TAKEN' }

  const [before] = await q(db)
    .select({
      name: schema.suppliers.name,
      phone: schema.suppliers.phone,
      gstin: schema.suppliers.gstin,
      is_active: schema.suppliers.isActive,
    })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, input.supplierId))

  const isActive = input.isActive === false ? 0 : 1

  await db.transaction(async (tx) => {
    await q(tx).update(schema.suppliers)
      .set({
        name,
        phone: blank(input.phone),
        gstin: blank(input.gstin),
        address: blank(input.address),
        isActive,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.suppliers.id, input.supplierId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'suppliers', entityId: input.supplierId, action: 'update',
      before: before ?? null,
      after: { name, phone: blank(input.phone), gstin: blank(input.gstin), is_active: isActive },
    })
  })

  return { ok: true, supplierId: input.supplierId }
}

export type ArchiveSupplierResult = { ok: true }

/**
 * A supplier the shop has finished with.
 *
 * This used to be `deleteSupplier`, and it did two things that did not match
 * each other. Its own doc comment said "a supplier anything was ever bought
 * from is switched off, never removed" -- and then it ran `DELETE FROM
 * suppliers` whenever nothing happened to reference the row, and refused with
 * "Switch it off instead" whenever something did. There was no switch-it-off
 * that removed anything, so the refusal pointed at a thing that did not exist,
 * and the delete threw away a row that the audit log still names.
 *
 * Now it archives, always, and cannot refuse. `suppliers.deleted_at` has been
 * filtered by every query in this file since they were written and nothing ever
 * set it; this is what sets it.
 *
 * The distinction from `is_active`, which this table also has and which *is*
 * wired to a checkbox: switched off means "not buying from them at the moment"
 * and keeps them in the list, badged. Archived means "off the list". A shop
 * uses the first for a seasonal supplier and the second for one that has shut.
 */
export async function archiveSupplier(
  db: SqlDriver,
  input: { supplierId: string; actorId: string },
): Promise<ArchiveSupplierResult> {
  const now = new Date().toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.suppliers)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(
        eq(schema.suppliers.id, input.supplierId),
        isNull(schema.suppliers.deletedAt),
      ))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'suppliers', entityId: input.supplierId, action: 'delete',
    })
  })
  return { ok: true }
}

/** Back onto the list, switched on or off exactly as they were left. */
export async function restoreSupplier(
  db: SqlDriver,
  input: { supplierId: string; actorId: string },
): Promise<void> {
  const now = new Date().toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.suppliers)
      .set({ deletedAt: null, updatedAt: now })
      .where(and(
        eq(schema.suppliers.id, input.supplierId),
        isNotNull(schema.suppliers.deletedAt),
      ))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'suppliers', entityId: input.supplierId, action: 'update',
      after: { Archived: 'no' },
    })
  })
}

export async function findOrCreateSupplier(
  db: SqlDriver,
  input: { name: string; actorId: string },
): Promise<string | null> {
  const name = input.name.trim()
  if (name === '') return null

  const [existing] = await q(db)
    .select({ id: schema.suppliers.id })
    .from(schema.suppliers)
    // raw: `COLLATE NOCASE`. "Sakthi Agencies" and "sakthi agencies" are the
    // one supplier this function exists to stop becoming two.
    .where(and(
      sql`${schema.suppliers.name} = ${name} COLLATE NOCASE`,
      isNull(schema.suppliers.deletedAt),
    ))
  if (existing) return existing.id

  const created = await createSupplier(db, { name, actorId: input.actorId })
  return created.ok ? created.supplierId : null
}

export interface PurchaseLine {
  postingDate: string
  docNo: string
  productName: string
  qty: number
  unitCost: Money
  amount: Money
}

/** What this supplier has been bought from, most recent first. */
export async function supplierPurchases(
  db: SqlDriver,
  supplierId: string,
  limit = 100,
): Promise<PurchaseLine[]> {
  const rows = await q(db)
    .select({
      postingDate: schema.stockEntries.postingDate,
      docNo: schema.stockEntries.docNo,
      productName: schema.products.name,
      qty: schema.stockEntryItems.qty,
      unitCost: schema.stockEntryItems.unitCost,
      /* The line's own money, which is a quantity scaled by ten thousand times
         a rate in paise. Rounded in SQLite rather than in JavaScript because
         that is where the multiplication happens. */
      amount: sql<Money>`CAST(ROUND(${schema.stockEntryItems.qty} *
        COALESCE(${schema.stockEntryItems.unitCost}, 0) / 10000.0) AS INTEGER)`,
    })
    .from(schema.stockEntryItems)
    .innerJoin(schema.stockEntries, eq(schema.stockEntries.id, schema.stockEntryItems.entryId))
    .innerJoin(schema.products, eq(schema.products.id, schema.stockEntryItems.productId))
    .where(and(
      eq(schema.stockEntries.supplierId, supplierId),
      eq(schema.stockEntries.docstatus, SUBMITTED),
    ))
    .orderBy(desc(schema.stockEntries.postingDate), desc(schema.stockEntries.docNo))
    .limit(limit)

  return rows
}

export interface SupplierItem {
  productId: string
  name: string
  /** Base units received, all time. */
  qty: number
  /** What those goods cost, all time. */
  spent: Money
  /** The rate on the most recent delivery, or null if none was recorded. */
  lastRate: Money | null
  /** The rate on the first, so the two together say which way it has moved. */
  firstRate: Money | null
  lastReceived: string
  deliveries: number
}

/**
 * What this supplier sends, and what they have been charging for it.
 *
 * The deliveries list answers "what arrived on Tuesday". This answers the
 * question a shopkeeper actually negotiates on -- what do I buy from them, how
 * much of it, and has the price moved -- which a list ordered by date cannot,
 * because the two deliveries to compare are six weeks apart and forty rows from
 * each other.
 *
 * First and last rate rather than a computed trend. Two numbers a person can
 * check against their own paperwork beat one number they have to take on trust,
 * and "is 285 to 300 a rise worth arguing about" is a judgement about this
 * supplier that the shopkeeper is better placed to make than this query is.
 *
 * `MIN`/`MAX` over `posting_date` picks the rate by date rather than by rowid,
 * so a delivery entered late lands where it belongs rather than at the end.
 */
export async function supplierItems(
  db: SqlDriver,
  supplierId: string,
): Promise<SupplierItem[]> {
  /* raw: the rate on the earliest and the latest delivery is a per-group
     first and last value. SQLite has no FIRST_VALUE outside a window, and a
     window function is not something the builder can say. */
  return db.query<SupplierItem>(
    `SELECT i.product_id                         AS productId,
            MAX(p.name)                          AS name,
            SUM(i.qty)                           AS qty,
            CAST(ROUND(SUM(i.qty * COALESCE(i.unit_cost, 0) / 10000.0)) AS INTEGER) AS spent,
            MAX(CASE WHEN e.posting_date = last.seen_on  THEN i.unit_cost END) AS lastRate,
            MAX(CASE WHEN e.posting_date = first.seen_on THEN i.unit_cost END) AS firstRate,
            MAX(e.posting_date)                  AS lastReceived,
            COUNT(DISTINCT e.id)                 AS deliveries
       FROM stock_entry_items i
       JOIN stock_entries e ON e.id = i.entry_id
       JOIN products      p ON p.id = i.product_id
       JOIN (SELECT i2.product_id AS pid, MAX(e2.posting_date) AS seen_on
               FROM stock_entry_items i2 JOIN stock_entries e2 ON e2.id = i2.entry_id
              WHERE e2.supplier_id = ? AND e2.docstatus = 1
              GROUP BY i2.product_id) last ON last.pid = i.product_id
       JOIN (SELECT i3.product_id AS pid, MIN(e3.posting_date) AS seen_on
               FROM stock_entry_items i3 JOIN stock_entries e3 ON e3.id = i3.entry_id
              WHERE e3.supplier_id = ? AND e3.docstatus = 1
              GROUP BY i3.product_id) first ON first.pid = i.product_id
      WHERE e.supplier_id = ? AND e.docstatus = ?
      GROUP BY i.product_id
      ORDER BY spent DESC`,
    [supplierId, supplierId, supplierId, SUBMITTED],
  )
}

function toSupplier(r: Omit<Supplier, 'isActive'> & { isActive: number }): Supplier {
  return { ...r, isActive: r.isActive === 1 }
}

async function nameTaken(db: SqlDriver, name: string, exceptId?: string): Promise<boolean> {
  const [row] = await q(db)
    .select({ id: schema.suppliers.id })
    .from(schema.suppliers)
    // raw: `COLLATE NOCASE`, as in `findOrCreateSupplier`.
    .where(and(
      sql`${schema.suppliers.name} = ${name} COLLATE NOCASE`,
      isNull(schema.suppliers.deletedAt),
      ...(exceptId === undefined ? [] : [ne(schema.suppliers.id, exceptId)]),
    ))
  return row !== undefined
}

function blank(value: string | undefined): string | null {
  return value?.trim() || null
}
