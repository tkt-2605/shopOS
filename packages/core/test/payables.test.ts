import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStockEntry, submitStockEntry, cancelStockEntry } from '../src/services/stockEntry.js'
import { createSupplier, setSupplierOpening, supplierSummaries } from '../src/services/suppliers.js'
import { paySupplier, supplierOwed } from '../src/services/payables.js'
import { cancelPayment } from '../src/services/payments.js'
import { ledgerChecks, partyBalance } from '../src/repos/ledger.js'
import { purchaseRegister } from '../src/repos/reports/purchases.js'
import { productValuation } from '../src/services/stock.js'
import { setSetting } from '../src/services/settings.js'
import { paise, rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * A purchase as the supplier's bill, and what the shop owes (migration 065).
 *
 * From the review of 4 October: a delivery recorded no tax and no invoice, so
 * input tax could not be added up; what the shop owed was a figure typed onto
 * the supplier that nothing moved; and the list's "most owed first" sorted by
 * that figure alone.
 */

let fx: Fixture
let rice: string
const ctx = { get actorId(): string { return fx.adminId } }
const MONTH = { from: '2026-06-01', to: '2026-06-30' }

beforeEach(async () => {
  fx = await freshDb()
  await setSetting(fx.db, 'shop_state_code', '33')
  await setSetting(fx.db, 'shop_tax_scheme', 'regular')
  rice = await makeProduct(fx.db, { name: 'Rice 25kg', baseRate: rupees(1300), taxRateBp: 500 })
})
afterEach(async () => { await fx.db.close() })

async function supplier(name: string, gstin: string | null): Promise<string> {
  const made = await createSupplier(fx.db, { name, ...(gstin ? { gstin } : {}), actorId: fx.adminId })
  if (!made.ok) throw new Error(made.code)
  return made.supplierId
}

async function bill(supplierId: string, units: number, opts: { rate?: number; roundOff?: number; on?: string } = {}) {
  const entry = await createStockEntry(fx.db, {
    entryType: 'purchase', supplierId, postingDate: opts.on ?? '2026-06-05',
    supplierInvoiceNo: 'INV-77', supplierInvoiceDate: '2026-06-04',
    ...(opts.roundOff !== undefined ? { roundOff: opts.roundOff as Money } : {}),
    lines: [{
      productId: rice, qty: fromUnits(units), unitCost: rupees(1000),
      ...(opts.rate !== undefined ? { taxRateBp: opts.rate } : {}),
    }],
    actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error(entry.code)
  const posted = await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
  if (!posted.ok) throw new Error(posted.code)
  return entry.entryId
}

describe('a supplier’s bill', () => {
  it('carries the GST it was billed, half and half from a supplier in the same state', async () => {
    const local = await supplier('Chennai Rice Mills', '33ALNPJ1906G1ZC')
    const id = await bill(local, 10, { rate: 500 })
    const row = await fx.db.get<{ invoice_total: number; supplier_invoice_no: string; input_tax_claimed: number }>(
      `SELECT invoice_total, supplier_invoice_no, input_tax_claimed FROM stock_entries WHERE id = ?`, [id])
    expect(row).toEqual({ invoice_total: rupees(10_500), supplier_invoice_no: 'INV-77', input_tax_claimed: 1 })
    const line = await fx.db.get<{ cgst_amount: number; sgst_amount: number; igst_amount: number }>(
      `SELECT cgst_amount, sgst_amount, igst_amount FROM stock_entry_items WHERE entry_id = ?`, [id])
    expect(line).toEqual({ cgst_amount: rupees(250), sgst_amount: rupees(250), igst_amount: 0 })
  })

  it('as IGST from a supplier in another state, and with their rounding', async () => {
    const away = await supplier('Bombay Traders', '27ALNPJ1906G1ZC')
    const id = await bill(away, 1, { rate: 500, roundOff: -40 })
    const line = await fx.db.get<{ igst_amount: number }>(`SELECT igst_amount FROM stock_entry_items WHERE entry_id = ?`, [id])
    expect(line!.igst_amount).toBe(rupees(50))
    expect(await supplierOwed(fx.db, away)).toBe(paise(105_000 - 40))
  })

  it('values the goods before tax when the shop claims the tax, and with it when it cannot', async () => {
    const local = await supplier('Chennai Rice Mills', '33ALNPJ1906G1ZC')
    await bill(local, 10, { rate: 500 })
    expect((await productValuation(fx.db, rice)).averageCost).toBe(rupees(1000))

    await setSetting(fx.db, 'shop_tax_scheme', 'composition')
    await bill(local, 10, { rate: 500 })
    // Ten at 1,000 and ten at 1,050: the second lot carries the tax it could not claim.
    expect((await productValuation(fx.db, rice)).averageCost).toBe(rupees(1025))
  })

  it('records no tax when none is given, as every purchase before 065 did', async () => {
    const local = await supplier('Chennai Rice Mills', '33ALNPJ1906G1ZC')
    await bill(local, 2)
    expect(await supplierOwed(fx.db, local)).toBe(rupees(2000))
  })
})

describe('what is owed', () => {
  it('is the balance carried over, plus the bills, less the payments', async () => {
    const s = await supplier('Chennai Rice Mills', '33ALNPJ1906G1ZC')
    await setSupplierOpening(fx.db, ctx, { supplierId: s, amount: rupees(500) as Money, asOf: '2026-05-31' })
    await bill(s, 1, { rate: 500 })
    const paid = await paySupplier(fx.db, { supplierId: s, amount: rupees(300) as Money, method: 'upi', actorId: fx.adminId })
    if (!paid.ok) throw new Error(paid.code)
    expect(await supplierOwed(fx.db, s)).toBe(rupees(500 + 1050 - 300))

    await cancelPayment(fx.db, { paymentId: paid.paymentId, actorId: fx.adminId })
    expect(await supplierOwed(fx.db, s)).toBe(rupees(1550))
  })

  it('and the books carry each supplier at exactly that, through corrections and cancellations', async () => {
    const a = await supplier('Chennai Rice Mills', '33ALNPJ1906G1ZC')
    const b = await supplier('Bombay Traders', '27ALNPJ1906G1ZC')
    await setSupplierOpening(fx.db, ctx, { supplierId: a, amount: rupees(500) as Money, asOf: '2026-05-31' })
    await setSupplierOpening(fx.db, ctx, { supplierId: a, amount: rupees(300) as Money, asOf: '2026-05-31' })
    await bill(a, 3, { rate: 500 })
    const wrong = await bill(b, 2, { rate: 500, roundOff: 25 })
    await cancelStockEntry(fx.db, { entryId: wrong, actorId: fx.adminId })
    await bill(b, 1, { rate: 500 })
    await paySupplier(fx.db, { supplierId: b, amount: rupees(100) as Money, method: 'cash', actorId: fx.adminId })

    for (const s of [a, b]) {
      expect(await partyBalance(fx.db, { type: 'supplier', id: s })).toBe(await supplierOwed(fx.db, s))
    }
    const checks = await ledgerChecks(fx.db)
    expect(checks.unbalanced).toEqual([])
    expect(checks.stockDrift).toBe(0)
  })

  it('decides who comes first on the list, not the balance carried over', async () => {
    const old = await supplier('Old supplier', null)
    const busy = await supplier('Busy supplier', null)
    await setSupplierOpening(fx.db, ctx, { supplierId: old, amount: rupees(100) as Money, asOf: '2026-05-31' })
    await bill(busy, 40)
    const list = await supplierSummaries(fx.db, { order: 'owed' })
    expect(list.map((s) => s.name).slice(0, 2)).toEqual(['Busy supplier', 'Old supplier'])
    expect(list[0]!.owed).toBe(rupees(40_000))
  })
})

describe('the purchase register', () => {
  it('lists each bill, and claims only tax billed by a registered supplier', async () => {
    const registered = await supplier('Chennai Rice Mills', '33ALNPJ1906G1ZC')
    const unregistered = await supplier('Farmer', null)
    await bill(registered, 2, { rate: 500 })
    await bill(unregistered, 1)
    const r = await purchaseRegister(fx.db, MONTH)
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]).toMatchObject({ invoiceNo: 'INV-77', supplierGstin: '33ALNPJ1906G1ZC', taxable: rupees(2000) })
    expect(r.claimable).toEqual({ igst: 0, cgst: rupees(50), sgst: rupees(50), cess: 0 })
  })
})
