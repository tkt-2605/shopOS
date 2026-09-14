import { describe, it, expect } from 'vitest'
import { buildInvoiceHtml } from '../src/domain/invoiceHtml.js'
import { STANDARD_INVOICE, type Block, type DocFormat } from '../src/domain/docFormat.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import type { ReceiptDoc } from '../src/domain/receipt.js'

/**
 * The sheet an invoice is printed on.
 *
 * Rendered as HTML rather than through `pdf.rs`, which carries only the
 * standard fourteen fonts and therefore cannot say ₹ or a word of Tamil. The
 * tests that matter here are the ones about what the sheet does that the roll
 * cannot, and the ones about not trusting text a shop typed.
 */

const doc: ReceiptDoc = {
  shop: {
    name: 'TRT Stationery',
    address: 'Perambalur 621212, Tamil Nadu',
    phone: '9047191778',
    gstin: '33ALNPJ1906G1ZC',
  },
  docNo: 'INV/MR/26-27/00023',
  postingDate: '2026-09-12',
  cashier: 'admin',
  customerName: 'Sri Vidya School',
  customerGstin: '33AAACS1234F1Z5',
  placeOfSupply: 'Tamil Nadu',
  items: [
    {
      name: 'A4 Copier Paper 500 sheets',
      qty: fromUnits(2), saleUnit: 'ream', rate: rupees(340), lineTotal: rupees(680),
      hsnCode: '4802', taxableValue: rupees(576.27),
      cgst: rupees(51.86), sgst: rupees(51.86), igst: 0 as Money,
    },
  ],
  subtotal: rupees(680),
  discount: rupees(0),
  taxableTotal: rupees(576.27),
  cgst: rupees(51.86),
  sgst: rupees(51.86),
  igst: 0 as Money,
  grandTotal: rupees(680),
  payments: [{ method: 'cash', amount: rupees(680) }],
}

const html = (format: DocFormat = STANDARD_INVOICE) => buildInvoiceHtml(doc, format)

function withBlocks(changes: Partial<Record<Block['kind'], boolean>>): DocFormat {
  return {
    ...STANDARD_INVOICE,
    blocks: STANDARD_INVOICE.blocks.map((b) =>
      b.kind in changes ? { ...b, on: changes[b.kind]! } : b,
    ),
  }
}

describe('what a sheet carries that a roll cannot', () => {
  it('gives each line its HSN code, which a tax invoice needs and 42 columns has no room for', () => {
    expect(html()).toContain('4802')
  })

  it('splits the tax per line as well as in total', () => {
    // 51.86 appears against the line and again in the summary.
    const occurrences = html().split('51.86').length - 1
    expect(occurrences).toBeGreaterThan(1)
  })

  it('states the customer in a block of their own, with their GSTIN', () => {
    const page = html()
    expect(page).toContain('Billed to')
    expect(page).toContain('33AAACS1234F1Z5')
  })

  it('names the place of supply, which decides whether the tax is IGST', () => {
    expect(html()).toContain('Tamil Nadu')
  })

  it('leaves room for a signature, because an invoice gets signed', () => {
    expect(html()).toContain('Authorised signatory')
  })

  it('can say the rupee sign, unlike the thermal printer', () => {
    const withSymbol: DocFormat = {
      ...STANDARD_INVOICE,
      blocks: [...STANDARD_INVOICE.blocks, { kind: 'text', on: true, opts: { body: 'Paid ₹680' } }],
    }
    expect(buildInvoiceHtml(doc, withSymbol)).toContain('₹680')
  })

  it('can say a name in Tamil, which the standard fourteen fonts cannot', () => {
    const tamil = { ...doc, customerName: 'ஸ்ரீ வித்யா பள்ளி' }
    expect(buildInvoiceHtml(tamil, STANDARD_INVOICE)).toContain('ஸ்ரீ வித்யா பள்ளி')
  })
})

describe('the same switches as the roll', () => {
  it('leaves the footer off the sheet when the shop turned it off', () => {
    const withTerms = { ...doc, terms: 'Payment within 30 days' }
    expect(buildInvoiceHtml(withTerms, STANDARD_INVOICE)).toContain('Payment within 30 days')
    expect(buildInvoiceHtml(withTerms, withBlocks({ terms: false }))).not.toContain('Payment within 30 days')
  })

  it('drops the customer block without touching the items', () => {
    const page = buildInvoiceHtml(doc, withBlocks({ party: false }))
    expect(page).not.toContain('Billed to')
    expect(page).toContain('A4 Copier Paper')
  })

  it('prints the blocks in the order the shop arranged them', () => {
    const reversed: DocFormat = { ...STANDARD_INVOICE, blocks: STANDARD_INVOICE.blocks.slice().reverse() }
    const page = buildInvoiceHtml(doc, reversed)
    expect(page.indexOf('Authorised signatory')).toBeLessThan(page.indexOf('class="shop-name"'))
  })

  it('says nothing for a block that has no renderer on either paper', () => {
    const withLogo: DocFormat = {
      ...STANDARD_INVOICE,
      blocks: [{ kind: 'logo', on: true }, ...STANDARD_INVOICE.blocks],
    }
    expect(buildInvoiceHtml(doc, withLogo)).toBe(html())
  })
})

describe('a bill with nothing extra on it', () => {
  const plain: ReceiptDoc = {
    ...doc,
    customerGstin: null,
    placeOfSupply: null,
    items: [{ name: 'Ball Pen', qty: fromUnits(1), saleUnit: 'piece', rate: rupees(10), lineTotal: rupees(10) }],
  }

  it('leaves the HSN column out rather than printing an empty one', () => {
    expect(buildInvoiceHtml(plain, STANDARD_INVOICE)).not.toContain('>HSN<')
  })

  it('leaves the tax columns out when the lines carry no tax split', () => {
    expect(buildInvoiceHtml(plain, STANDARD_INVOICE)).not.toContain('>Taxable<')
  })

  it('still produces a whole page', () => {
    const page = buildInvoiceHtml(plain, STANDARD_INVOICE)
    expect(page.startsWith('<!doctype html>')).toBe(true)
    expect(page).toContain('</html>')
  })
})

describe('text the shop typed', () => {
  function withText(body: string): DocFormat {
    return { ...STANDARD_INVOICE, blocks: [...STANDARD_INVOICE.blocks, { kind: 'text', on: true, opts: { body } }] }
  }

  it('fills the tokens in', () => {
    expect(buildInvoiceHtml(doc, withText('Queries: {{shop.phone}}'))).toContain('Queries: 9047191778')
  })

  it('escapes markup rather than letting it into the page', () => {
    // A product name with an ampersand would break the page on its own; a shop
    // is free to type anything at all into a text block.
    const page = buildInvoiceHtml(doc, withText('<script>alert(1)</script>'))
    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&lt;script&gt;')
  })

  it('escapes an ampersand in a product name', () => {
    const amp = { ...doc, items: [{ ...doc.items[0]!, name: 'Pens & Pencils' }] }
    const page = buildInvoiceHtml(amp, STANDARD_INVOICE)
    expect(page).toContain('Pens &amp; Pencils')
  })
})

describe('the page itself', () => {
  it('asks for the paper size the format names', () => {
    expect(html()).toContain('size: A4')
    expect(buildInvoiceHtml(doc, { ...STANDARD_INVOICE, paper: 'a5' })).toContain('size: A5')
  })

  it('keeps a line item from being sliced across a page break', () => {
    expect(html()).toContain('break-inside: avoid')
  })

  it('prints itself only when asked to', () => {
    expect(html()).not.toContain('window.print()')
    expect(buildInvoiceHtml(doc, STANDARD_INVOICE, { autoPrint: true })).toContain('window.print()')
  })

  it('carries its styling inline, having nowhere to fetch a stylesheet from', () => {
    expect(html()).toContain('<style>')
    expect(html()).not.toContain('<link')
  })
})

describe('what the browser must not print around it', () => {
  /**
   * A browser draws the page address, the date and "1 / 1" into the @page
   * margin box. A customer's invoice with "localhost:1420" along the foot of
   * it is not an invoice a shop can hand over, and the only switch for it is a
   * tickbox inside a print dialog. Giving the margin up removes the box.
   */

  it('leaves no page margin for the address and the date to be drawn in', () => {
    expect(html()).toContain('margin: 0;')
    expect(html()).not.toContain('margin: 14mm')
  })

  it('still keeps the invoice off the edge of the paper', () => {
    expect(html()).toContain('.sheet { padding: 14mm; }')
  })

  it('holds the same strip open on a second page', () => {
    // Padding indents the first page only. A row inside a thead is repeated at
    // the top of every printed page, and a tfoot at the foot of every one.
    const page = html()
    expect(page).toContain('<thead><tr><td><div class="edge"></div></td></tr></thead>')
    expect(page).toContain('<tfoot><tr><td><div class="edge"></div></td></tr></tfoot>')
    expect(page).toContain('.edge { height: 14mm; }')
  })

  it('takes up none of that strip on screen, where there are no pages', () => {
    // The preview is one continuous frame, so a repeated strip would only read
    // as a gap in the middle of the document.
    expect(html()).toContain('.edge { height: 0; }')
  })
})

describe('the amount in words', () => {
  it('spells the total out when the shop switches the block on', () => {
    expect(html(withBlocks({ amount_in_words: true }))).toContain('Rupees Six Hundred Eighty Only')
  })

  it('is absent by default, so a shop that never opened the designer sees no change', () => {
    expect(html()).not.toContain('Amount in words')
  })
})
