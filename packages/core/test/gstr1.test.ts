import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildGstr1, gstr1Files, b2clThreshold, uqcFor, type InvoiceRate } from '../src/domain/gstr1.js'
import { gstr1 } from '../src/repos/reports/gstr1.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { processReturn } from '../src/services/returns.js'
import { setSetting } from '../src/services/settings.js'
import { paise, rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * GSTR-1 in the sections it is filed in.
 *
 * From the review of 4 October: the GST tab exported one row per document per
 * rate and left the sorting into B2B, B2CL, B2CS, the two kinds of credit note,
 * the HSN summary and the document summary to whoever filed it.
 */

const invoice = (over: Partial<InvoiceRate>): InvoiceRate => ({
  invoiceNo: 'BMR/2627/00001', invoiceDate: '2026-06-10', invoiceValue: rupees(1180),
  customerName: null, gstin: null, placeOfSupply: '33', supplyType: 'intra_state', rateBp: 1800,
  taxable: rupees(1000), igst: 0 as Money, cgst: rupees(90), sgst: rupees(90), cess: 0 as Money,
  ...over,
})

describe('the sections', () => {
  it('puts a registered buyer in B2B, whatever the size or the state', () => {
    const g = buildGstr1({
      shopState: '33', invoices: [invoice({ gstin: '33ALNPJ1906G1ZC', customerName: 'Sri Vidya School' })],
      notes: [], hsn: [], numbered: [],
    })
    expect(g.b2b).toHaveLength(1)
    expect(g.b2cs).toEqual([])
  })

  it('puts a large unregistered sale across a state line in B2CL, and a small one in B2CS', () => {
    const big = invoice({
      invoiceNo: 'BMR/2627/00002', placeOfSupply: '27', supplyType: 'inter_state',
      invoiceValue: rupees(118_000), taxable: rupees(100_000), cgst: 0 as Money, sgst: 0 as Money, igst: rupees(18_000),
    })
    const small = invoice({
      invoiceNo: 'BMR/2627/00003', placeOfSupply: '27', supplyType: 'inter_state',
      invoiceValue: rupees(1180), igst: rupees(180), cgst: 0 as Money, sgst: 0 as Money,
    })
    const g = buildGstr1({ shopState: '33', invoices: [big, small, invoice({})], notes: [], hsn: [], numbered: [] })
    expect(g.b2cl.map((r) => r.invoiceNo)).toEqual(['BMR/2627/00002'])
    expect(g.b2cs).toEqual([
      { placeOfSupply: '27', rateBp: 1800, taxable: rupees(1000), cess: 0 },
      { placeOfSupply: '33', rateBp: 1800, taxable: rupees(1000), cess: 0 },
    ])
  })

  it('reads the B2CL threshold of the invoice’s own date', () => {
    expect(b2clThreshold('2024-07-31')).toBe(rupees(250_000))
    expect(b2clThreshold('2024-08-01')).toBe(rupees(100_000))
  })

  it('nets a credit note on a small unregistered sale into B2CS, and lists the others', () => {
    const note = {
      noteNo: 'CMR/2627/00001', noteDate: '2026-06-12', noteValue: rupees(590),
      invoiceNo: 'BMR/2627/00001', invoiceDate: '2026-06-10', invoiceValue: rupees(1180),
      customerName: null, gstin: null, placeOfSupply: '33', supplyType: 'intra_state' as const, rateBp: 1800,
      taxable: rupees(500), igst: 0 as Money, cgst: rupees(45), sgst: rupees(45), cess: 0 as Money,
    }
    const g = buildGstr1({
      shopState: '33', invoices: [invoice({})],
      notes: [note, { ...note, noteNo: 'CMR/2627/00002', gstin: '33ALNPJ1906G1ZC' }],
      hsn: [], numbered: [],
    })
    expect(g.b2cs).toEqual([{ placeOfSupply: '33', rateBp: 1800, taxable: rupees(500), cess: 0 }])
    expect(g.cdnr.map((r) => r.noteNo)).toEqual(['CMR/2627/00002'])
    expect(g.cdnur).toEqual([])
  })

  it('summarises each series by its first and last number, and counts what was cancelled', () => {
    const g = buildGstr1({
      shopState: '33', invoices: [], notes: [], hsn: [],
      numbered: [
        { nature: 'invoice', docNo: 'BMR/2627/00003', cancelled: false },
        { nature: 'invoice', docNo: 'BMR/2627/00001', cancelled: false },
        { nature: 'invoice', docNo: 'BMR/2627/00002', cancelled: true },
        { nature: 'invoice', docNo: 'BBK/2627/00001', cancelled: false },
        { nature: 'credit_note', docNo: 'CMR/2627/00001', cancelled: false },
      ],
    })
    expect(g.docs).toEqual([
      { nature: 'Credit Note', from: 'CMR/2627/00001', to: 'CMR/2627/00001', total: 1, cancelled: 0 },
      { nature: 'Invoices for outward supply', from: 'BBK/2627/00001', to: 'BBK/2627/00001', total: 1, cancelled: 0 },
      { nature: 'Invoices for outward supply', from: 'BMR/2627/00001', to: 'BMR/2627/00003', total: 3, cancelled: 1 },
    ])
  })

  it('names units the way GSTN does, and says OTH rather than guess', () => {
    expect(uqcFor('piece')).toBe('PCS')
    expect(uqcFor('Kg')).toBe('KGS')
    expect(uqcFor('litre')).toBe('LTR')
    expect(uqcFor('thaali')).toBe('OTH')
  })
})

let fx: Fixture
beforeEach(async () => {
  fx = await freshDb()
  await setSetting(fx.db, 'shop_state_code', '33')
})
afterEach(async () => { await fx.db.close() })

async function sell(productId: string, units: number, customerId?: string): Promise<string> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId, qty: fromUnits(units) }],
    ...(customerId ? { customerId } : {}), actorId: fx.adminId, now: new Date('2026-06-10T11:00:00'),
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: customerId ? 'credit' : 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId, now: new Date('2026-06-10T11:00:00'),
  })
  if (!done.ok) throw new Error(done.code)
  return draft.billId
}

describe('a month of real bills', () => {
  it('lands each in its section, nets the returns, and writes the files a CA loads', async () => {
    const pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(118), taxRateBp: 1800 })
    await fx.db.execute(`UPDATE products SET hsn_code = '96081019' WHERE id = ?`, [pen])
    const generator = await makeProduct(fx.db, { name: 'Generator', baseRate: rupees(150_000), taxRateBp: 1800 })
    await fx.db.execute(`UPDATE products SET hsn_code = '85021100' WHERE id = ?`, [generator])

    const school = await makeCustomer(fx.db, 'Sri Vidya School')
    await fx.db.execute(`UPDATE customers SET gstin = '33ALNPJ1906G1ZC', credit_limit = 0 WHERE id = ?`, [school])
    const mumbai = await makeCustomer(fx.db, 'Mumbai buyer')
    await fx.db.execute(`UPDATE customers SET state_code = '27', gstin = NULL WHERE id = ?`, [mumbai])

    await sell(pen, 10, school)              // B2B
    await sell(generator, 1, mumbai)         // B2CL: inter-state, over a lakh
    const walkIn = await sell(pen, 2)        // B2CS
    const cancelled = await sell(pen, 1)     // cancelled: Table 13 only
    await cancelBill(fx.db, { billId: cancelled, actorId: fx.adminId })

    const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [walkIn])
    const ret = await processReturn(fx.db, {
      billId: walkIn, lines: [{ billItemId: item!.id, qty: fromUnits(1) }], refundMethod: 'cash',
      actorId: fx.adminId, now: new Date('2026-06-12T11:00:00'),
    })
    if (!ret.ok) throw new Error(ret.code)

    const g = await gstr1(fx.db, { from: '2026-06-01', to: '2026-06-30' })
    expect(g.b2b).toHaveLength(1)
    expect(g.b2b[0]).toMatchObject({ gstin: '33ALNPJ1906G1ZC', taxable: rupees(1000), rateBp: 1800 })
    expect(g.b2cl).toHaveLength(1)
    expect(g.b2cl[0]).toMatchObject({ placeOfSupply: '27', invoiceValue: rupees(150_000) })
    // Two pens sold to a walk-in, one brought back: one pen's taxable value is left.
    expect(g.b2cs).toEqual([{ placeOfSupply: '33', rateBp: 1800, taxable: rupees(100), cess: 0 }])
    expect(g.cdnr).toEqual([])
    expect(g.cdnur).toEqual([])

    expect(g.hsnB2b).toEqual([expect.objectContaining({ hsn: '96081019', uqc: 'PCS', qty: 10 * 10_000 })])
    const penB2c = g.hsnB2c.find((h) => h.hsn === '96081019')!
    expect(penB2c.qty).toBe(1 * 10_000)
    expect(penB2c.taxable).toBe(rupees(100))

    const invoices = g.docs.find((d) => d.nature === 'Invoices for outward supply')!
    expect(invoices).toMatchObject({ total: 4, cancelled: 1 })

    const files = gstr1Files(g)
    expect(files.map((f) => f.section)).toEqual(['b2b', 'b2cl', 'b2cs', 'hsn-b2b', 'hsn-b2c', 'docs'])
    const b2b = files.find((f) => f.section === 'b2b')!.csv
    expect(b2b).toContain('33ALNPJ1906G1ZC')
    expect(b2b).toContain('10-Jun-2026')
    expect(b2b).toContain('33-Tamil Nadu')
  })
})

void paise
