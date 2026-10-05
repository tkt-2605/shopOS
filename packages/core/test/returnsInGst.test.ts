import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { processReturn } from '../src/services/returns.js'
import { setSetting } from '../src/services/bootstrap.js'
import { taxByRate, gstLines } from '../src/repos/reports.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * What the GST export says about goods that came back.
 *
 * It said nothing. `taxByRate` and `gstLines` read `bill_items` and stopped
 * there, so a shop that sold for a thousand rupees and refunded a thousand
 * rupees declared a thousand rupees of taxable value and the output tax on it —
 * tax it had already handed back across the counter. The sales summary, which
 * does read `sales_returns`, showed the same day as nil. Two screens, two
 * answers, and the wrong one was the one the CA filed from.
 *
 * GSTR-1 has a table for credit notes (9B) precisely because this is not
 * optional. Rule 53 says what a credit note has to carry: the invoice it is
 * raised against, and the same rate and HSN as the line it reverses.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ALL = { from: '2026-01-01', to: '2026-12-31' }

/** A submitted bill, and the ids of the lines that can be sent back. */
async function sell(
  lines: { productId: string; units: number }[],
  opts: { date?: string; customerId?: string } = {},
): Promise<{ billId: string; docNo: string; items: { id: string; rate: number }[] }> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    ...(opts.date ? { postingDate: opts.date } : {}),
    lines: lines.map((l) => ({ productId: l.productId, qty: fromUnits(l.units) })),
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')

  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
    ...(opts.date ? { now: new Date(`${opts.date}T12:00:00`) } : {}),
  })
  if (!done.ok) throw new Error(`submit failed: ${done.code}`)

  const items = await fx.db.query<{ id: string; rate: number }>(
    `SELECT id, tax_rate_bp AS rate FROM bill_items WHERE bill_id = ? ORDER BY idx`,
    [draft.billId],
  )
  return { billId: draft.billId, docNo: done.docNo, items }
}

async function sendBack(
  billId: string,
  billItemId: string,
  units: number,
  date?: string,
): Promise<{ docNo: string; refundTotal: Money }> {
  const done = await processReturn(fx.db, {
    billId,
    lines: [{ billItemId, qty: fromUnits(units) }],
    refundMethod: 'cash',
    actorId: fx.adminId,
    ...(date ? { now: new Date(`${date}T11:00:00`) } : {}),
  })
  if (!done.ok) throw new Error(`return failed: ${done.code}`)
  return { docNo: done.docNo, refundTotal: done.refundTotal }
}

describe('a return in the GST export', () => {
  it('appears as a credit note against the invoice it reverses', async () => {
    const p = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(500), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 2 }], { date: '2026-03-01' })

    const credit = await sendBack(sale.billId, sale.items[0]!.id, 1, '2026-03-04')
    expect(credit.refundTotal).toBe(rupees(500))

    const lines = await gstLines(fx.db, ALL)
    expect(lines).toHaveLength(2)

    const invoice = lines.find((l) => l.kind === 'invoice')!
    const note = lines.find((l) => l.kind === 'credit_note')!

    expect(invoice.docNo).toBe(sale.docNo)
    expect(invoice.againstDocNo).toBeNull()
    expect(invoice.total).toBe(rupees(1000))

    // Its own number, carrying the invoice number it is raised against — Rule
    // 53(1)(e). A credit note filed without it cannot be matched to anything.
    expect(note.docNo).toBe(credit.docNo)
    expect(note.againstDocNo).toBe(sale.docNo)
    expect(note.total).toBe(-rupees(500))
    expect(note.taxable).toBeLessThan(0)
    expect(note.cgst).toBeLessThan(0)
    expect(note.rateBp).toBe(1800)
  })

  it('takes the taxable value and the tax back out of the rate summary', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 2 }], { date: '2026-03-01' })

    const before = await taxByRate(fx.db, ALL)
    expect(before).toHaveLength(1)

    await sendBack(sale.billId, sale.items[0]!.id, 1, '2026-03-04')

    const reversed = await fx.db.get<{ taxable: number; cgst: number; sgst: number }>(
      `SELECT SUM(taxable_value) AS taxable, SUM(cgst_amount) AS cgst, SUM(sgst_amount) AS sgst
         FROM sales_return_items`,
    )

    const after = await taxByRate(fx.db, ALL)
    expect(after).toHaveLength(1)

    /* To the paisa, and against the credit note's own figures rather than a
       number worked out twice: what the export declares is what the shop
       actually credited back. */
    expect(after[0]!.taxable).toBe(before[0]!.taxable - reversed!.taxable)
    expect(after[0]!.cgst).toBe(before[0]!.cgst - reversed!.cgst)
    expect(after[0]!.sgst).toBe(before[0]!.sgst - reversed!.sgst)
  })

  it('nets a fully returned sale to nothing, which is what was filed', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 1 }], { date: '2026-03-01' })
    await sendBack(sale.billId, sale.items[0]!.id, 1, '2026-03-01')

    const rows = await taxByRate(fx.db, ALL)
    // Not "no rows" — the rate is still in the period, it simply comes to zero.
    expect(rows).toHaveLength(1)
    expect(rows[0]!).toMatchObject({ taxable: 0, cgst: 0, sgst: 0, igst: 0 })
  })

  it('belongs to the period it was raised in, not the period of the invoice', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 2 }], { date: '2026-03-01' })
    await sendBack(sale.billId, sale.items[0]!.id, 1, '2026-04-10')

    /* March has been filed. A credit note raised in April is declared in April,
       and reaching back to reduce a filed month would put the export out of
       agreement with the return that was actually made. */
    const march = await gstLines(fx.db, { from: '2026-03-01', to: '2026-03-31' })
    expect(march.map((l) => l.kind)).toEqual(['invoice'])

    const april = await gstLines(fx.db, { from: '2026-04-01', to: '2026-04-30' })
    expect(april.map((l) => l.kind)).toEqual(['credit_note'])
    expect(april[0]!.againstDocNo).toBe(sale.docNo)

    const aprilRates = await taxByRate(fx.db, { from: '2026-04-01', to: '2026-04-30' })
    expect(aprilRates[0]!.taxable).toBeLessThan(0)
  })

  it('leaves a draft return out until somebody submits it', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 2 }], { date: '2026-03-01' })

    const { createReturn } = await import('../src/services/returns.js')
    const draft = await createReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.items[0]!.id, qty: fromUnits(1) }],
      refundMethod: 'cash',
      actorId: fx.adminId,
    })
    expect(draft.ok).toBe(true)

    // Nothing has been credited to anybody. A draft is not a document.
    const lines = await gstLines(fx.db, ALL)
    expect(lines.map((l) => l.kind)).toEqual(['invoice'])
  })
})

describe('what the credit note carries', () => {
  it('copies the HSN and the rate off the line it reverses, not off the product', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 1800 })
    await fx.db.execute(`UPDATE products SET hsn_code = '4820' WHERE id = ?`, [p])

    const sale = await sell([{ productId: p, units: 2 }], { date: '2026-03-01' })

    /* The shop re-rates the product afterwards, which shops do. Rule 53 asks
       the credit note to carry what was charged, so the later rate must not
       reach it. */
    await fx.db.execute(`UPDATE products SET tax_rate_bp = 500, hsn_code = '9999' WHERE id = ?`, [p])
    await sendBack(sale.billId, sale.items[0]!.id, 1, '2026-03-04')

    const row = await fx.db.get<{ hsn_code: string | null; tax_rate_bp: number }>(
      `SELECT hsn_code, tax_rate_bp FROM sales_return_items`,
    )
    expect(row?.hsn_code).toBe('4820')
    expect(row?.tax_rate_bp).toBe(1800)
  })

  it('reverses the tax the bill charged, even after the shop corrects its own state', async () => {
    await setSetting(fx.db, 'shop_state_code', '33')

    const customerId = await makeCustomer(fx.db, 'Ramesh Traders')
    await fx.db.execute(`UPDATE customers SET state_code = '27' WHERE id = ?`, [customerId])

    const p = await makeProduct(fx.db, { baseRate: rupees(590), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 2 }], { date: '2026-03-01', customerId })

    const charged = await fx.db.get<{ igst: number; cgst: number }>(
      `SELECT SUM(igst_amount) AS igst, SUM(cgst_amount) AS cgst FROM bill_items WHERE bill_id = ?`,
      [sale.billId],
    )
    expect(charged!.igst).toBeGreaterThan(0)
    expect(charged!.cgst).toBe(0)

    /* The shop discovers its own state code was wrong and fixes it. That is a
       correction going forward; it says nothing about a sale already made.
       `computeLines` used to re-derive the supply type from this setting, so the
       correction turned every later credit note against an old inter-state bill
       into CGST+SGST — reversing tax under heads the shop never collected it
       under, and leaving the IGST it did collect declared and unrecoverable. */
    await setSetting(fx.db, 'shop_state_code', '27')

    await sendBack(sale.billId, sale.items[0]!.id, 1, '2026-03-04')

    const reversed = await fx.db.get<{ igst: number; cgst: number; sgst: number }>(
      `SELECT SUM(igst_amount) AS igst, SUM(cgst_amount) AS cgst, SUM(sgst_amount) AS sgst
         FROM sales_return_items`,
    )
    expect(reversed!.igst).toBeGreaterThan(0)
    expect(reversed!.cgst).toBe(0)
    expect(reversed!.sgst).toBe(0)

    const note = (await gstLines(fx.db, ALL)).find((l) => l.kind === 'credit_note')!
    expect(note.igst).toBeLessThan(0)
    expect(note.cgst).toBe(0)
  })
})

describe('the rate rows and the bill they came from', () => {
  it('puts the rounding on the last rate row so the rows tie to the grand total', async () => {
    await setSetting(fx.db, 'round_off_rule', 'nearest')

    const five = await makeProduct(fx.db, { baseRate: 10049 as Money, taxRateBp: 500 })
    const eighteen = await makeProduct(fx.db, { baseRate: 20026 as Money, taxRateBp: 1800 })
    const sale = await sell(
      [{ productId: five, units: 1 }, { productId: eighteen, units: 1 }],
      { date: '2026-03-01' },
    )

    const bill = await fx.db.get<{ grand_total: number; round_off: number }>(
      `SELECT grand_total, round_off FROM bills WHERE id = ?`, [sale.billId])
    expect(bill!.round_off).not.toBe(0)

    const lines = await gstLines(fx.db, ALL)
    expect(lines).toHaveLength(2)

    /* The point of the whole exercise: a CA adding the export up against the
       invoices is not left out by up to 49 paise a bill with nothing to point
       at. */
    expect(lines.reduce((s, l) => s + l.total, 0)).toBe(bill!.grand_total)

    // And it lands in one place rather than being spread, because a rate's
    // taxable value is the one number here that must not be adjusted.
    expect(lines[0]!.total).toBe(lines[0]!.taxable + lines[0]!.cgst + lines[0]!.sgst)
    expect(lines[1]!.total).toBe(
      lines[1]!.taxable + lines[1]!.cgst + lines[1]!.sgst + bill!.round_off)
  })

  it('does not round a credit note, which was never rounded', async () => {
    await setSetting(fx.db, 'round_off_rule', 'nearest')

    const p = await makeProduct(fx.db, { baseRate: 10049 as Money, taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 2 }], { date: '2026-03-01' })
    const credit = await sendBack(sale.billId, sale.items[0]!.id, 1, '2026-03-04')

    const note = (await gstLines(fx.db, ALL)).find((l) => l.kind === 'credit_note')!
    expect(note.total).toBe(-credit.refundTotal)
    expect(note.total).toBe(note.taxable + note.cgst + note.sgst + note.igst)
  })
})

describe('the recipient on an exported line', () => {
  it('is the one the invoice was issued to, not the one in the file today', async () => {
    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')
    await fx.db.execute(`UPDATE customers SET gstin = '33ALNPJ1906G1ZC' WHERE id = ?`, [customerId])

    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 1800 })
    await sell([{ productId: p, units: 1 }], { date: '2026-03-01', customerId })

    /* The customer corrects their registration, or the shop finds it was typed
       wrong. Read through a live join, that rewrote every invoice ever issued to
       them: a reprint stopped matching the copy in their hand and the export
       stopped matching the return already filed. */
    await fx.db.execute(
      `UPDATE customers SET gstin = '27AABCR5678G1Z2', name = 'Sri Vidya Trust' WHERE id = ?`,
      [customerId],
    )

    const lines = await gstLines(fx.db, ALL)
    expect(lines[0]!.gstin).toBe('33ALNPJ1906G1ZC')
    expect(lines[0]!.customerName).toBe('Sri Vidya School')
  })

  it('is written onto the bill at submit, where every renderer can find it', async () => {
    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')
    await fx.db.execute(
      `UPDATE customers SET gstin = '33ALNPJ1906G1ZC', address = '12 Bazaar Street, Trichy',
              state_code = '33' WHERE id = ?`,
      [customerId],
    )
    await setSetting(fx.db, 'shop_state_code', '33')

    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 1 }], { date: '2026-03-01', customerId })

    const row = await fx.db.get<{
      supply_type: string; customer_gstin: string; customer_address: string
      customer_state_code: string; reverse_charge: number
    }>(
      `SELECT supply_type, customer_gstin, customer_address, customer_state_code, reverse_charge
         FROM bills WHERE id = ?`, [sale.billId])

    expect(row).toMatchObject({
      supply_type: 'intra_state',
      customer_gstin: '33ALNPJ1906G1ZC',
      customer_address: '12 Bazaar Street, Trichy',
      customer_state_code: '33',
      // Nothing in this product raises a bill under reverse charge, and Rule 46
      // still requires the invoice to say so.
      reverse_charge: 0,
    })
  })

  it('says the supply was inter-state when that is what was charged', async () => {
    await setSetting(fx.db, 'shop_state_code', '33')
    const customerId = await makeCustomer(fx.db, 'Ramesh Traders')
    await fx.db.execute(`UPDATE customers SET state_code = '27' WHERE id = ?`, [customerId])

    const p = await makeProduct(fx.db, { baseRate: rupees(590), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 1 }], { date: '2026-03-01', customerId })

    const row = await fx.db.get<{ supply_type: string; customer_state_code: string }>(
      `SELECT supply_type, customer_state_code FROM bills WHERE id = ?`, [sale.billId])
    expect(row?.supply_type).toBe('inter_state')
    expect(row?.customer_state_code).toBe('27')
  })

  it('leaves a walk-in without a place of supply rather than inventing one', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 1800 })
    const sale = await sell([{ productId: p, units: 1 }], { date: '2026-03-01' })

    const row = await fx.db.get<{ supply_type: string; customer_state_code: string | null }>(
      `SELECT supply_type, customer_state_code FROM bills WHERE id = ?`, [sale.billId])

    // Nobody said where they were from, and CGST+SGST is what a counter sale
    // owes. The column stays empty because the honest answer is that it is.
    expect(row?.supply_type).toBe('intra_state')
    expect(row?.customer_state_code).toBeNull()
  })
})
