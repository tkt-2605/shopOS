import { describe, it, expect } from 'vitest'
import { buildReceipt, previewLines, visibleLines, type ReceiptDoc } from '../src/domain/receipt.js'
import { STANDARD_RECEIPT, type DocFormat } from '../src/domain/docFormat.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'

/**
 * Showing a shopkeeper their own receipt.
 *
 * The preview is the only thing standing between a change and a roll of wasted
 * paper, so what it leaves out matters as much as what it shows.
 */

const doc: ReceiptDoc = {
  shop: { name: 'TRT Stationery', address: 'Perambalur 621212', phone: '9047191778', gstin: '33ALNPJ1906G1ZC' },
  docNo: 'INV/MR/26-27/00023',
  postingDate: '2026-09-12',
  cashier: 'admin',
  customerName: 'Sri Vidya School',
  items: [{ name: 'Ball Pen Blue', qty: fromUnits(12), saleUnit: 'piece', rate: rupees(10), lineTotal: rupees(120) }],
  subtotal: rupees(120),
  discount: rupees(0),
  taxableTotal: rupees(101.69),
  cgst: rupees(9.15),
  sgst: rupees(9.15),
  igst: 0 as Money,
  grandTotal: rupees(120),
  payments: [{ method: 'cash', amount: rupees(120) }],
}

const lines = () => previewLines(buildReceipt(doc))
const find = (startsWith: string) => lines().find((l) => l.text.startsWith(startsWith))!

describe('what the preview keeps', () => {
  it('shows the same characters the printer is sent', () => {
    // The column arithmetic is the part a preview must never round off.
    expect(previewLines(buildReceipt(doc)).map((l) => l.text))
      .toEqual(visibleLines(buildReceipt(doc)))
  })

  it('centres the shop name, because the printer does', () => {
    // Shown flush left it reads as a hole in the layout rather than a banner.
    expect(find('TRT Stationery').align).toBe('centre')
  })

  it('shows the shop name at banner size', () => {
    expect(find('TRT Stationery').banner).toBe(true)
  })

  it('centres the address and phone under it', () => {
    expect(find('Perambalur').align).toBe('centre')
    expect(find('Ph: ').align).toBe('centre')
  })

  it('goes back to flush left for the bill number', () => {
    expect(find('INV/MR').align).toBe('left')
  })

  it('sets the total taller than the lines around it', () => {
    expect(find('TOTAL').tall).toBe(true)
    expect(find('Subtotal').tall).toBe(false)
  })

  it('marks the footer note as the small print it is', () => {
    expect(find('Thank you').small).toBe(true)
    expect(find('Thank you').align).toBe('centre')
  })
})

describe('what the preview leaves out', () => {
  it('shows no control codes as text', () => {
    for (const line of lines()) {
      // eslint-disable-next-line no-control-regex
      expect(line.text).not.toMatch(/[\x1B\x1D]/)
    }
  })

  it('ends with the same number of lines the printer is sent', () => {
    // The cut and the paper feed are commands, not lines. If either leaked
    // through, the preview would show a line the printer never prints.
    expect(previewLines(buildReceipt(doc)))
      .toHaveLength(visibleLines(buildReceipt(doc)).length)
  })
})

describe('a block the shop switched on', () => {
  it('shows a title centred and tall, the way it will print', () => {
    const titled: DocFormat = {
      ...STANDARD_RECEIPT,
      blocks: STANDARD_RECEIPT.blocks.map((b) =>
        b.kind === 'title' ? { ...b, on: true, opts: { label: 'TAX INVOICE' } } : b,
      ),
    }
    const line = previewLines(buildReceipt(doc, titled)).find((l) => l.text === 'TAX INVOICE')!

    expect(line.align).toBe('centre')
    expect(line.tall).toBe(true)
  })

  it('shows the customer heading in bold when the party block is on', () => {
    const withParty: DocFormat = {
      ...STANDARD_RECEIPT,
      blocks: STANDARD_RECEIPT.blocks.map((b) => (b.kind === 'party' ? { ...b, on: true } : b)),
    }
    expect(previewLines(buildReceipt(doc, withParty)).find((l) => l.text === 'Customer')!.bold).toBe(true)
  })
})
