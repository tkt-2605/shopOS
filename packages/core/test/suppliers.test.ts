import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import {
  listSuppliers, supplierSummaries, createSupplier, updateSupplier,
  deleteSupplier, findOrCreateSupplier, supplierPurchases,
} from '../src/services/suppliers.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function receive(supplierId: string, productId: string, units: number, unitCost: number) {
  const entry = await createStockEntry(fx.db, {
    entryType: 'purchase',
    supplierId,
    lines: [{ productId, qty: fromUnits(units), unitCost: unitCost as never }],
    actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error('entry failed')
  await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
  return entry.entryId
}

describe('suppliers', () => {
  it('creates one and lists it', async () => {
    const made = await createSupplier(fx.db, {
      name: 'Sakthi Agencies', phone: '9047191778', gstin: '33ALNPJ1906G1ZC', actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)

    const rows = await listSuppliers(fx.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Sakthi Agencies')
    expect(rows[0]!.gstin).toBe('33ALNPJ1906G1ZC')
    expect(rows[0]!.isActive).toBe(true)
  })

  it('refuses a duplicate name whatever the capitals', async () => {
    await createSupplier(fx.db, { name: 'Sakthi Agencies', actorId: fx.adminId })
    expect(await createSupplier(fx.db, { name: 'sakthi agencies', actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NAME_TAKEN' })
  })

  it('refuses a nameless supplier', async () => {
    expect(await createSupplier(fx.db, { name: '   ', actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NO_NAME' })
  })

  /* This is the whole reason the record exists rather than a typed name: the same
     vendor spelled three ways is three vendors, and no history joins up. */
  it('resolves a typed name to the same supplier however it is capitalised', async () => {
    const first = await findOrCreateSupplier(fx.db, { name: 'Sakthi Agencies', actorId: fx.adminId })
    const again = await findOrCreateSupplier(fx.db, { name: '  sakthi AGENCIES ', actorId: fx.adminId })

    expect(again).toBe(first)
    expect(await listSuppliers(fx.db)).toHaveLength(1)
  })

  it('has nothing to resolve for an empty name', async () => {
    expect(await findOrCreateSupplier(fx.db, { name: '  ', actorId: fx.adminId })).toBeNull()
  })

  it('hides a switched-off supplier from the picker but keeps it on the screen', async () => {
    const made = await createSupplier(fx.db, { name: 'Old Vendor', actorId: fx.adminId })
    if (!made.ok) throw new Error('setup failed')
    await updateSupplier(fx.db, { supplierId: made.supplierId, name: 'Old Vendor', isActive: false, actorId: fx.adminId })

    expect(await listSuppliers(fx.db)).toHaveLength(0)
    expect(await listSuppliers(fx.db, true)).toHaveLength(1)
    expect((await supplierSummaries(fx.db))[0]!.isActive).toBe(false)
  })

  it('totals what was bought from each supplier', async () => {
    const p = await makeProduct(fx.db, { name: 'A4 Paper' })
    const q = await makeProduct(fx.db, { name: 'Ball Pen' })
    const made = await createSupplier(fx.db, { name: 'Sakthi Agencies', actorId: fx.adminId })
    if (!made.ok) throw new Error('setup failed')

    await receive(made.supplierId, p, 10, rupees(300))
    await receive(made.supplierId, q, 100, rupees(6))

    const summary = (await supplierSummaries(fx.db))[0]!
    expect(summary.entryCount).toBe(2)
    expect(summary.purchased).toBe(rupees(3600))
    expect(summary.lastPurchase).not.toBeNull()
  })

  it('counts nothing against a supplier whose entry is still a draft', async () => {
    const p = await makeProduct(fx.db)
    const made = await createSupplier(fx.db, { name: 'Sakthi Agencies', actorId: fx.adminId })
    if (!made.ok) throw new Error('setup failed')

    await createStockEntry(fx.db, {
      entryType: 'purchase',
      supplierId: made.supplierId,
      lines: [{ productId: p, qty: fromUnits(5), unitCost: rupees(100) as never }],
      actorId: fx.adminId,
    })

    const summary = (await supplierSummaries(fx.db))[0]!
    expect(summary.entryCount).toBe(0)
    expect(summary.purchased).toBe(0)
  })

  it('lists what a supplier actually delivered', async () => {
    const p = await makeProduct(fx.db, { name: 'A4 Paper' })
    const made = await createSupplier(fx.db, { name: 'Sakthi Agencies', actorId: fx.adminId })
    if (!made.ok) throw new Error('setup failed')
    await receive(made.supplierId, p, 10, rupees(300))

    const lines = await supplierPurchases(fx.db, made.supplierId)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.productName).toBe('A4 Paper')
    expect(lines[0]!.unitCost).toBe(rupees(300))
    expect(lines[0]!.amount).toBe(rupees(3000))
    expect(lines[0]!.docNo).not.toMatch(/^DRAFT/)
  })

  it('refuses to delete a supplier goods were bought from, and says where', async () => {
    const p = await makeProduct(fx.db)
    const made = await createSupplier(fx.db, { name: 'Sakthi Agencies', actorId: fx.adminId })
    if (!made.ok) throw new Error('setup failed')
    await receive(made.supplierId, p, 5, rupees(100))

    const result = await deleteSupplier(fx.db, { supplierId: made.supplierId, actorId: fx.adminId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('stock entries')
    expect(result.message).toContain('Switch it off instead')
  })

  it('removes one that was never used', async () => {
    const made = await createSupplier(fx.db, { name: 'Typo Vendor', actorId: fx.adminId })
    if (!made.ok) throw new Error('setup failed')

    expect(await deleteSupplier(fx.db, { supplierId: made.supplierId, actorId: fx.adminId })).toEqual({ ok: true })
    expect(await listSuppliers(fx.db, true)).toHaveLength(0)
  })
})
