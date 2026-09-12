import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DRAFT, SUBMITTED, CANCELLED, canApply, nextStatus, assertEditable,
  assertAmendable, DocStatusError, affectsLedgers,
} from '../src/integrity/docstatus.js'
import { loadPermissions, can, assertCan, canSeePage, PermissionError } from '../src/integrity/permissions.js'
import { checkLinks, assertDeletable, LinkedRecordError } from '../src/integrity/links.js'
import { diffFields, writeAudit } from '../src/integrity/audit.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'

describe('docstatus transitions', () => {
  it('allows the legal moves', () => {
    expect(canApply(DRAFT, 'save')).toBe(true)
    expect(canApply(DRAFT, 'submit')).toBe(true)
    expect(canApply(DRAFT, 'delete')).toBe(true)
    expect(canApply(SUBMITTED, 'cancel')).toBe(true)
  })

  it('refuses to edit a submitted document', () => {
    expect(canApply(SUBMITTED, 'save')).toBe(false)
    expect(() => assertEditable('bill', SUBMITTED)).toThrow(DocStatusError)
  })

  it('refuses to delete a submitted document', () => {
    expect(canApply(SUBMITTED, 'delete')).toBe(false)
  })

  it('refuses to resurrect a cancelled document', () => {
    expect(canApply(CANCELLED, 'submit')).toBe(false)
    expect(canApply(CANCELLED, 'save')).toBe(false)
    expect(canApply(CANCELLED, 'cancel')).toBe(false)
  })

  it('refuses to cancel a draft — there is nothing posted to reverse', () => {
    expect(canApply(DRAFT, 'cancel')).toBe(false)
  })

  it('maps actions to the resulting status', () => {
    expect(nextStatus(DRAFT, 'submit')).toBe(SUBMITTED)
    expect(nextStatus(SUBMITTED, 'cancel')).toBe(CANCELLED)
    expect(nextStatus(DRAFT, 'delete')).toBeNull()
  })

  it('only posts to ledgers when submitted', () => {
    expect(affectsLedgers(DRAFT)).toBe(false)
    expect(affectsLedgers(SUBMITTED)).toBe(true)
    expect(affectsLedgers(CANCELLED)).toBe(false)
  })

  it('amends only from cancelled', () => {
    expect(() => assertAmendable('bill', CANCELLED)).not.toThrow()
    expect(() => assertAmendable('bill', SUBMITTED)).toThrow(/cancel it first/)
    expect(() => assertAmendable('bill', DRAFT)).toThrow()
  })
})

describe('permissions', () => {
  let fx: Fixture
  beforeEach(async () => { fx = await freshDb() })
  afterEach(async () => { await fx.db.close() })

  it('gives Admin everything', async () => {
    const perms = await loadPermissions(fx.db, fx.seed.roleIds['Admin']!)
    expect(can(perms, 'bill', 'cancel')).toBe(true)
    expect(can(perms, 'role', 'write')).toBe(true)
  })

  it('lets a Cashier submit a bill but not cancel or amend one', async () => {
    const perms = await loadPermissions(fx.db, fx.seed.roleIds['Cashier']!)
    expect(can(perms, 'bill', 'submit')).toBe(true)
    expect(can(perms, 'bill', 'cancel')).toBe(false)
    expect(can(perms, 'bill', 'amend')).toBe(false)
    expect(() => assertCan(perms, 'bill', 'cancel')).toThrow(PermissionError)
  })

  it('keeps a Stockist out of billing and money', async () => {
    const perms = await loadPermissions(fx.db, fx.seed.roleIds['Stockist']!)
    expect(can(perms, 'bill', 'create')).toBe(false)
    expect(can(perms, 'payment', 'create')).toBe(false)
    expect(can(perms, 'stock_entry', 'submit')).toBe(true)
  })

  it('hides pages and the matching routes together', async () => {
    const cashier = await loadPermissions(fx.db, fx.seed.roleIds['Cashier']!)
    expect(canSeePage(cashier, 'billing')).toBe(true)
    expect(canSeePage(cashier, 'users')).toBe(false)
    expect(canSeePage(cashier, 'pricing')).toBe(false)

    const stockist = await loadPermissions(fx.db, fx.seed.roleIds['Stockist']!)
    expect(canSeePage(stockist, 'inventory')).toBe(true)
    expect(canSeePage(stockist, 'billing')).toBe(false)
  })

  it('reflects an owner turning a page on for a role', async () => {
    const roleId = fx.seed.roleIds['Cashier']!
    await fx.db.execute(
      `INSERT INTO role_pages (role_id, page_key, visible) VALUES (?, 'reports', 1)
       ON CONFLICT (role_id, page_key) DO UPDATE SET visible = 1`,
      [roleId],
    )
    const perms = await loadPermissions(fx.db, roleId)
    expect(canSeePage(perms, 'reports')).toBe(true)
  })

  it('is idempotent across repeated bootstraps', async () => {
    const before = await fx.db.query(`SELECT id FROM roles`)
    const { bootstrap } = await import('../src/services/bootstrap.js')
    await bootstrap(fx.db, { shopName: 'Test Shop' })
    const after = await fx.db.query(`SELECT id FROM roles`)
    expect(after).toHaveLength(before.length)
  })
})

describe('link checking', () => {
  let fx: Fixture
  beforeEach(async () => { fx = await freshDb() })
  afterEach(async () => { await fx.db.close() })

  it('allows deleting an unreferenced product', async () => {
    const productId = await makeProduct(fx.db)
    const check = await checkLinks(fx.db, 'products', productId)
    expect(check.deletable).toBe(true)
  })

  it('refuses to delete a product that is on a bill, and says where', async () => {
    const productId = await makeProduct(fx.db, { name: 'Pencil' })
    const billId = await seedBill(fx, productId)

    const check = await checkLinks(fx.db, 'products', productId)
    expect(check.deletable).toBe(false)
    expect(check.references.some((r) => r.label === 'bills' && r.count === 1)).toBe(true)

    await expect(assertDeletable(fx.db, 'products', productId)).rejects.toThrow(LinkedRecordError)
    await expect(assertDeletable(fx.db, 'products', productId)).rejects.toThrow(/Deactivate it instead/)
    expect(billId).toBeTruthy()
  })

  it('refuses to delete a role that still has users', async () => {
    await expect(assertDeletable(fx.db, 'roles', fx.seed.roleIds['Admin']!)).rejects.toThrow(/users/)
  })

  it('refuses to delete a customer with bills', async () => {
    const productId = await makeProduct(fx.db)
    const customerId = await makeCustomer(fx.db)
    await seedBill(fx, productId, customerId)
    const check = await checkLinks(fx.db, 'customers', customerId)
    expect(check.deletable).toBe(false)
  })

  it('treats an entity with no rules as free to delete', async () => {
    const check = await checkLinks(fx.db, 'settings', 'shop_name')
    expect(check.deletable).toBe(true)
  })
})

describe('history is immutable under master edits', () => {
  let fx: Fixture
  beforeEach(async () => { fx = await freshDb() })
  afterEach(async () => { await fx.db.close() })

  it('keeps the bill line as issued when the product changes afterwards', async () => {
    const productId = await makeProduct(fx.db, { name: 'Pencil', baseRate: 1000 })
    await seedBill(fx, productId)

    await fx.db.execute(`UPDATE products SET name = 'Pencil HB', base_rate = 5000, tax_rate_bp = 2800 WHERE id = ?`, [productId])

    const line = await fx.db.get<{ product_name: string; rate: number; tax_rate_bp: number }>(
      `SELECT product_name, rate, tax_rate_bp FROM bill_items WHERE product_id = ?`,
      [productId],
    )
    expect(line?.product_name).toBe('Pencil')
    expect(line?.rate).toBe(1000)
    expect(line?.tax_rate_bp).toBe(1800)
  })
})

describe('audit', () => {
  let fx: Fixture
  beforeEach(async () => { fx = await freshDb() })
  afterEach(async () => { await fx.db.close() })

  it('records only the fields that changed', () => {
    const diff = diffFields({ name: 'A', rate: 100, rev: 1 }, { name: 'B', rate: 100, rev: 2 })
    expect(diff).toEqual({ name: { from: 'A', to: 'B' } })
  })

  it('ignores bookkeeping columns', () => {
    expect(diffFields({ rev: 1, updated_at: 'x' }, { rev: 2, updated_at: 'y' })).toBeNull()
  })

  it('returns null when nothing changed', () => {
    expect(diffFields({ a: 1 }, { a: 1 })).toBeNull()
  })

  it('writes one row per change, inside the caller transaction', async () => {
    await fx.db.transaction(async (tx) => {
      await writeAudit(tx, { actorId: fx.adminId }, {
        entity: 'products', entityId: 'p1', action: 'update',
        before: { name: 'A' }, after: { name: 'B' },
      })
    })
    const rows = await fx.db.query<{ entity: string; diff: string }>(`SELECT entity, diff FROM audit_log`)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.diff)).toEqual({ name: { from: 'A', to: 'B' } })
  })

  it('leaves no trace when the surrounding transaction rolls back', async () => {
    await expect(
      fx.db.transaction(async (tx) => {
        await writeAudit(tx, { actorId: fx.adminId }, { entity: 'products', entityId: 'p1', action: 'delete' })
        throw new Error('changed my mind')
      }),
    ).rejects.toThrow()
    expect(await fx.db.query(`SELECT id FROM audit_log`)).toHaveLength(0)
  })

  it('records the docstatus transition on submit', async () => {
    await fx.db.transaction(async (tx) => {
      await writeAudit(tx, { actorId: fx.adminId }, {
        entity: 'bills', entityId: 'b1', action: 'submit',
        docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      })
    })
    const row = await fx.db.get<{ docstatus_from: number; docstatus_to: number }>(
      `SELECT docstatus_from, docstatus_to FROM audit_log`,
    )
    expect(row?.docstatus_from).toBe(0)
    expect(row?.docstatus_to).toBe(1)
  })
})

async function seedBill(fx: Fixture, productId: string, customerId?: string): Promise<string> {
  const billId = newId()
  const now = new Date().toISOString()
  await fx.db.execute(
    `INSERT INTO bills (id, doc_no, docstatus, register_id, customer_id, posting_date, grand_total, created_by, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '2026-01-01', 1180, ?, ?, ?)`,
    [billId, `INV-${billId.slice(0, 8)}`, fx.seed.registerId, customerId ?? null, fx.adminId, now, now],
  )
  await fx.db.execute(
    `INSERT INTO bill_items
       (id, bill_id, idx, product_id, product_name, sale_unit, qty, base_qty, rate, line_total, tax_rate_bp, price_source)
     VALUES (?, ?, 1, ?, 'Pencil', 'piece', 10000, 10000, 1000, 1000, 1800, 'base_rate')`,
    [newId(), billId, productId],
  )
  return billId
}
