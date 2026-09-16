import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'

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

export async function listSuppliers(db: SqlDriver, includeInactive = false): Promise<Supplier[]> {
  const rows = await db.query<{
    id: string; name: string; phone: string | null; gstin: string | null
    address: string | null; is_active: number
  }>(
    `SELECT id, name, phone, gstin, address, is_active
       FROM suppliers
      WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND is_active = 1'}
      ORDER BY name`,
  )
  return rows.map(toSupplier)
}

/** The list with what has actually been bought, for the suppliers screen. */
export async function supplierSummaries(
  db: SqlDriver,
  opts: { includeArchived?: boolean } = {},
): Promise<SupplierSummary[]> {
  const rows = await db.query<{
    id: string; name: string; phone: string | null; gstin: string | null
    address: string | null; is_active: number; deleted_at: string | null
    n: number; last_purchase: string | null; purchased: number
  }>(
    `SELECT s.id, s.name, s.phone, s.gstin, s.address, s.is_active, s.deleted_at,
            COUNT(e.id) AS n,
            MAX(e.posting_date) AS last_purchase,
            COALESCE(SUM(
              (SELECT COALESCE(SUM(CAST(ROUND(i.qty * i.unit_cost / 10000.0) AS INTEGER)), 0)
                 FROM stock_entry_items i WHERE i.entry_id = e.id)
            ), 0) AS purchased
       FROM suppliers s
       LEFT JOIN stock_entries e ON e.supplier_id = s.id AND e.docstatus = 1
      ${opts.includeArchived ? '' : 'WHERE s.deleted_at IS NULL'}
      GROUP BY s.id
      ORDER BY s.name`,
  )
  return rows.map((r) => ({
    ...toSupplier(r),
    entryCount: r.n,
    lastPurchase: r.last_purchase,
    purchased: r.purchased as Money,
    archived: r.deleted_at !== null,
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
    await tx.execute(
      `INSERT INTO suppliers (id, name, phone, gstin, address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, blank(input.phone), blank(input.gstin), blank(input.address), now, now],
    )
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

  const before = await db.get<{ name: string; phone: string | null; gstin: string | null; is_active: number }>(
    `SELECT name, phone, gstin, is_active FROM suppliers WHERE id = ?`, [input.supplierId],
  )

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE suppliers SET name = ?, phone = ?, gstin = ?, address = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
      [
        name, blank(input.phone), blank(input.gstin), blank(input.address),
        input.isActive === false ? 0 : 1, new Date().toISOString(), input.supplierId,
      ],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'suppliers', entityId: input.supplierId, action: 'update',
      before: before ? { name: before.name, phone: before.phone, gstin: before.gstin, is_active: before.is_active } : null,
      after: { name, phone: blank(input.phone), gstin: blank(input.gstin), is_active: input.isActive === false ? 0 : 1 },
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
    await tx.execute(
      `UPDATE suppliers SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [now, now, input.supplierId],
    )
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
    await tx.execute(
      `UPDATE suppliers SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`,
      [now, input.supplierId],
    )
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

  const existing = await db.get<{ id: string }>(
    `SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`, [name],
  )
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
  const rows = await db.query<{
    posting_date: string; doc_no: string; name: string
    qty: number; unit_cost: number | null; amount: number
  }>(
    `SELECT e.posting_date, e.doc_no, p.name,
            i.qty, i.unit_cost,
            CAST(ROUND(i.qty * COALESCE(i.unit_cost, 0) / 10000.0) AS INTEGER) AS amount
       FROM stock_entry_items i
       JOIN stock_entries e ON e.id = i.entry_id
       JOIN products p ON p.id = i.product_id
      WHERE e.supplier_id = ? AND e.docstatus = 1
      ORDER BY e.posting_date DESC, e.doc_no DESC
      LIMIT ?`,
    [supplierId, limit],
  )

  return rows.map((r) => ({
    postingDate: r.posting_date,
    docNo: r.doc_no,
    productName: r.name,
    qty: r.qty,
    unitCost: (r.unit_cost ?? 0) as Money,
    amount: r.amount as Money,
  }))
}

function toSupplier(r: {
  id: string; name: string; phone: string | null
  gstin: string | null; address: string | null; is_active: number
}): Supplier {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    gstin: r.gstin,
    address: r.address,
    isActive: r.is_active === 1,
  }
}

async function nameTaken(db: SqlDriver, name: string, exceptId?: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM suppliers
      WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND (? IS NULL OR id <> ?)`,
    [name, exceptId ?? null, exceptId ?? ''],
  )
  return row !== undefined
}

function blank(value: string | undefined): string | null {
  return value?.trim() || null
}
