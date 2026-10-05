import { eq, ne, and, isNull, isNotNull, asc, desc, count, max, sql, type SQL } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { businessDate } from '../dates.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import { closedFor, type PeriodClosed } from './books.js'
import { postVoucherGl } from './ledger.js'
import { OWED } from './payables.js'
import { requirePermission } from '../integrity/permissions.js'

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
  /**
   * What the shop owed them when the books moved, and the day they closed.
   *
   * Positive: the shop owed them. Negative: they are holding the shop's
   * money -- an advance paid, or an overpayment in the old book. Null `asOf`
   * means nobody has ever said, which is not the same as having said zero.
   */
  openingBalance: Money
  openingAsOf: string | null
  entryCount: number
  lastPurchase: string | null
  purchased: Money
  /**
   * What the shop owes them now: the balance carried over, plus their bills,
   * less what has been paid them (065). Negative: they hold the shop's money.
   */
  owed: Money
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

/** The two carried by the summary and not by the picker. */
const openingShape = {
  openingBalance: schema.suppliers.openingBalance,
  openingAsOf: schema.suppliers.openingAsOf,
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

/**
 * How the supplier list comes back.
 *
 * Decided by the query, the same as `CustomerOrder` -- and for the same
 * reason, even though this list is rarely long enough for it to bite: a shop
 * has forty suppliers, not four thousand, but `purchased` and `owed` are both
 * computed columns, and sorting them in the screen would mean the screen
 * recomputing money the database already worked out.
 */
export type SupplierOrder =
  /** Alphabetical. The default, and what a picker wants. */
  | 'name'
  /** Most owed now first -- who to pay. Negative balances last. */
  | 'owed'
  /** Most bought from, ever. Who the shop actually depends on. */
  | 'bought'
  /** Longest since a delivery. Who has gone quiet. */
  | 'quietest'

/** The list with what has actually been bought, for the suppliers screen. */
export async function supplierSummaries(
  db: SqlDriver,
  opts: { includeArchived?: boolean; order?: SupplierOrder } = {},
): Promise<SupplierSummary[]> {
  const rows = await q(db)
    .select({
      ...supplierShape,
      ...openingShape,
      deletedAt: schema.suppliers.deletedAt,
      entryCount: count(schema.stockEntries.id),
      owed: OWED,
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
    .orderBy(...supplierOrderFor(opts.order ?? 'name'))

  return rows.map((r) => ({
    ...toSupplier(r),
    openingBalance: r.openingBalance,
    openingAsOf: r.openingAsOf,
    entryCount: r.entryCount,
    lastPurchase: r.lastPurchase,
    purchased: r.purchased,
    owed: r.owed,
    archived: r.deletedAt !== null,
  }))
}

export type OpeningResult =
  | { ok: true; amount: Money }
  | { ok: false; code: 'NO_SUPPLIER' }
  | PeriodClosed

/**
 * What the shop already owed this supplier before any of this started.
 *
 * A figure on the supplier rather than a document, because there is no
 * purchase invoice for it to be -- `050_what_the_shop_owed_before.sql` carries
 * the argument and the cost.
 *
 * Unlike the customer side there is no `ALREADY_SET`: this is a field, and
 * correcting a number somebody typed wrong is the ordinary case rather than
 * an error. The correction is audited, which is the whole of the trail until
 * Phase 5 gives suppliers a ledger.
 *
 * Zero is a real answer and is stored as one -- a shop saying "we owed them
 * nothing" has said something, and `openingAsOf` is what tells that apart
 * from never having been asked.
 */
export async function setSupplierOpening(
  db: SqlDriver,
  ctx: AuditContext,
  input: { supplierId: string; amount: Money; asOf?: string | null },
): Promise<OpeningResult> {
  await requirePermission(db, ctx.actorId, 'supplier', 'write')
  const [before] = await q(db)
    .select({
      openingBalance: schema.suppliers.openingBalance,
      openingAsOf: schema.suppliers.openingAsOf,
    })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, input.supplierId))

  if (!before) return { ok: false, code: 'NO_SUPPLIER' }

  const asOf = input.asOf ?? businessDate()
  /* Both ends: moving a figure out of a closed period changes it as surely as
     moving one in. */
  const closed = await closedFor(db, asOf) ??
    (before.openingAsOf === null ? null : await closedFor(db, before.openingAsOf))
  if (closed) return closed

  await db.transaction(async (tx) => {
    await q(tx).update(schema.suppliers)
      .set({
        openingBalance: input.amount,
        openingAsOf: asOf,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.suppliers.id, input.supplierId))

    // The books carry the difference, as a voucher of its own. See `supplierOpeningLines`.
    await postVoucherGl(tx, 'supplier_opening', input.supplierId)

    await writeAudit(tx, ctx, {
      entity: 'suppliers',
      entityId: input.supplierId,
      action: 'update',
      before: { opening_balance: before.openingBalance, opening_as_of: before.openingAsOf },
      after: { opening_balance: input.amount, opening_as_of: asOf },
    })
  })

  return { ok: true, amount: input.amount }
}

/**
 * The ORDER BY for a listing order.
 *
 * Name is the tiebreak in every case, so two suppliers owed the same amount
 * do not swap places between one load and the next.
 */
function supplierOrderFor(order: SupplierOrder): SQL[] {
  switch (order) {
    case 'owed':
      /* What is owed now, not the balance carried over from before. Sorting by
         that one figure put a supplier owed nothing from the old book and
         ₹40,000 since at the bottom of "who to pay" (review, 4 October). */
      return [desc(OWED), asc(schema.suppliers.name)]
    case 'bought':
      /* raw: the same per-entry subquery the SELECT sums, because an alias
         from the projection is not addressable in ORDER BY through the
         builder. If one changes the other must. */
      return [
        desc(sql`COALESCE(SUM((
          SELECT COALESCE(SUM(CAST(ROUND(i.qty * i.unit_cost / 10000.0) AS INTEGER)), 0)
            FROM stock_entry_items i WHERE i.entry_id = stock_entries.id)), 0)`),
        asc(schema.suppliers.name),
      ]
    case 'quietest':
      // Nulls first: a supplier nothing has ever come from is the quietest.
      return [asc(sql`COALESCE(MAX(stock_entries.posting_date), '')`), asc(schema.suppliers.name)]
    case 'name':
      return [asc(schema.suppliers.name)]
  }
}

export type SupplierResult =
  | { ok: true; supplierId: string }
  | { ok: false; code: 'NAME_TAKEN' }
  | { ok: false; code: 'NO_NAME' }

export async function createSupplier(
  db: SqlDriver,
  input: { name: string; phone?: string; gstin?: string; address?: string; actorId: string },
): Promise<SupplierResult> {
  await requirePermission(db, input.actorId, 'supplier', 'create')
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
  await requirePermission(db, input.actorId, 'supplier', 'write')
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
  await requirePermission(db, input.actorId, 'supplier', 'delete')
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
  await requirePermission(db, input.actorId, 'supplier', 'delete')
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
  await requirePermission(db, input.actorId, 'supplier', 'create')
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
