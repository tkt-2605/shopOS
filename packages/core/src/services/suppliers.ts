import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'
import { checkLinks } from '../integrity/links.js'

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
export async function supplierSummaries(db: SqlDriver): Promise<SupplierSummary[]> {
  const rows = await db.query<{
    id: string; name: string; phone: string | null; gstin: string | null
    address: string | null; is_active: number
    n: number; last_purchase: string | null; purchased: number
  }>(
    `SELECT s.id, s.name, s.phone, s.gstin, s.address, s.is_active,
            COUNT(e.id) AS n,
            MAX(e.posting_date) AS last_purchase,
            COALESCE(SUM(
              (SELECT COALESCE(SUM(CAST(ROUND(i.qty * i.unit_cost / 10000.0) AS INTEGER)), 0)
                 FROM stock_entry_items i WHERE i.entry_id = e.id)
            ), 0) AS purchased
       FROM suppliers s
       LEFT JOIN stock_entries e ON e.supplier_id = s.id AND e.docstatus = 1
      WHERE s.deleted_at IS NULL
      GROUP BY s.id
      ORDER BY s.name`,
  )
  return rows.map((r) => ({
    ...toSupplier(r),
    entryCount: r.n,
    lastPurchase: r.last_purchase,
    purchased: r.purchased as Money,
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

export type DeleteSupplierResult =
  | { ok: true }
  | { ok: false; code: 'IN_USE'; message: string }

/**
 * A supplier anything was ever bought from is switched off, never removed —
 * deleting one would orphan the purchase history that gives stock its cost.
 */
export async function deleteSupplier(
  db: SqlDriver,
  input: { supplierId: string; actorId: string },
): Promise<DeleteSupplierResult> {
  const links = await checkLinks(db, 'suppliers', input.supplierId)
  if (!links.deletable) {
    const ref = links.references[0]!
    return {
      ok: false,
      code: 'IN_USE',
      message: ref.example
        ? `${ref.count} ${ref.label} reference this supplier, including ${ref.example}. Switch it off instead.`
        : `${ref.count} ${ref.label} reference this supplier. Switch it off instead.`,
    }
  }

  await db.transaction(async (tx) => {
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'suppliers', entityId: input.supplierId, action: 'delete',
    })
    await tx.execute(`DELETE FROM suppliers WHERE id = ?`, [input.supplierId])
  })

  return { ok: true }
}

/** Resolves a typed name to a supplier, creating one the first time it is seen. */
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
