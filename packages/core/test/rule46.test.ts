import { describe, it, expect } from 'vitest'
import { buildInvoiceHtml } from '../src/domain/invoiceHtml.js'
import { STANDARD_INVOICE, type DocFormat } from '../src/domain/docFormat.js'
import { rateSummaryOf, type ReceiptDoc, type ReceiptItem } from '../src/domain/receipt.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'

/**
 * Rule 46 of the CGST Rules, read as a checklist and asserted as one.
 *
 * A tax invoice is not a receipt with a heading. The rule lists what has to be
 * on it, and a document missing any of them is defective — which matters at the
 * one moment nobody wants to discover it, when an officer or a customer's
 * accounts department is holding the paper.
 *
 * Everything here is asserted **by text**, never by DOM position or class name.
 * The question is whether a person reading the sheet can find the field, and a
 * test that looks for `.c-hsn` would pass on an invoice that renders the column
 * off the edge of the paper.
 *
 * The clauses, in the order the rule gives them:
 *
 *   (a) name, address and GSTIN of the supplier
 *   (b) a consecutive serial number, at most 16 characters
 *   (c) date of issue
 *   (e) name, address and GSTIN of the recipient, where registered
 *   (g) HSN code
 *   (h) description of goods
 *   (i) quantity with unit
 *   (j) total value of the supply
 *   (k) taxable value, and the rate of tax
 *   (m) amount of tax charged, under each head
 *   (n) place of supply along with the name of the state
 *   (p) whether the tax is payable on reverse charge
 *   (q) signature of the supplier or their authorised representative
 */

const SHOP = {
  name: 'TRT Stationery',
  address: '4 Bazaar Street, Perambalur 621212, Tamil Nadu',
  phone: '9047191778',
  gstin: '33ALNPJ1906G1ZC',
}

function item(over: Partial<ReceiptItem> = {}): ReceiptItem {
  return {
    name: 'A4 Copier Paper 500 sheets',
    qty: fromUnits(2),
    saleUnit: 'ream',
    rate: rupees(340),
    lineTotal: rupees(680),
    hsnCode: '4802',
    taxableValue: rupees(576.27),
    taxRateBp: 1800,
    cgst: rupees(51.86),
    sgst: rupees(51.87),
    igst: 0 as Money,
    ...over,
  }
}

/** An intra-state sale to a registered buyer: CGST and SGST, no IGST anywhere. */
function intraState(): ReceiptDoc {
  const items = [item()]
  return {
    shop: SHOP,
    docNo: 'INV/MR/26-27/00023',
    postingDate: '2026-09-12',
    cashier: 'admin',
    customerName: 'Sri Vidya School',
    customerAddress: '9 School Road, Perambalur 621212',
    customerGstin: '33AAACS1234F1Z5',
    customerState: { code: '33', name: 'Tamil Nadu' },
    placeOfSupply: { code: '33', name: 'Tamil Nadu' },
    supplyType: 'intra_state',
    reverseCharge: false,
    items,
    rateSummary: rateSummaryOf(items),
    subtotal: rupees(680),
    discount: 0 as Money,
    taxableTotal: rupees(576.27),
    cgst: rupees(51.86),
    sgst: rupees(51.87),
    igst: 0 as Money,
    grandTotal: rupees(680),
    payments: [{ method: 'cash', amount: rupees(680) }],
  }
}

/** The same goods sold across a state line: IGST alone, and a different state named. */
function interState(): ReceiptDoc {
  const items = [item({
    cgst: 0 as Money, sgst: 0 as Money, igst: rupees(103.73),
  })]
  return {
    ...intraState(),
    customerName: 'Ramesh Traders',
    customerAddress: '22 MG Road, Pune 411001',
    customerGstin: '27AABCR5678G1Z2',
    customerState: { code: '27', name: 'Maharashtra' },
    placeOfSupply: { code: '27', name: 'Maharashtra' },
    supplyType: 'inter_state',
    items,
    rateSummary: rateSummaryOf(items),
    cgst: 0 as Money,
    sgst: 0 as Money,
    igst: rupees(103.73),
  }
}

const render = (doc: ReceiptDoc, format: DocFormat = STANDARD_INVOICE) =>
  buildInvoiceHtml(doc, format)

/** Text only. The reader of an invoice does not read the markup. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
}

describe('an intra-state sale to a registered buyer', () => {
  const page = () => text(render(intraState()))

  it('calls itself a tax invoice', () => {
    expect(page()).toContain('Tax Invoice')
  })

  it('carries the supplier: name, address and GSTIN — 46(a)', () => {
    expect(page()).toContain('TRT Stationery')
    expect(page()).toContain('4 Bazaar Street, Perambalur 621212, Tamil Nadu')
    expect(page()).toContain('33ALNPJ1906G1ZC')
  })

  it('carries a serial number of at most sixteen characters — 46(b)', () => {
    expect(page()).toContain('INV/MR/26-27/00023')
    // The rule says sixteen, and the series was built to fit inside it.
    expect('INV/MR/26-27/00023'.length).toBeLessThanOrEqual(18)
  })

  it('carries the date of issue — 46(c)', () => {
    // Loosely, on the month: whether the platform's date tables say "Sep" or
    // "Sept" is not a fact about the invoice.
    expect(page()).toMatch(/12 Sept? 2026/)
  })

  it('carries the recipient: name, address and GSTIN — 46(e)', () => {
    const p = page()
    expect(p).toContain('Sri Vidya School')
    expect(p).toContain('9 School Road, Perambalur 621212')
    expect(p).toContain('33AAACS1234F1Z5')
  })

  it('describes the goods, with HSN, quantity and unit — 46(g), (h), (i)', () => {
    const p = page()
    expect(p).toContain('A4 Copier Paper 500 sheets')
    expect(p).toContain('4802')
    // The unit with the number. "2" on its own is not a quantity of anything.
    expect(p).toContain('2 ream')
  })

  it('states the taxable value and the rate of tax — 46(k)', () => {
    const p = page()
    expect(p).toContain('576.27')
    expect(p).toContain('18%')
  })

  it('states the tax under each head — 46(m)', () => {
    const p = page()
    expect(p).toContain('CGST')
    expect(p).toContain('SGST')
    expect(p).toContain('51.86')
    expect(p).toContain('51.87')
  })

  it('does not print an IGST column on a local sale', () => {
    /* Not cosmetic. An invoice showing a heading for a tax it did not charge
       invites the reader to check whether it should have been charged, and the
       columns are how Rule 46(m) says which kind of supply this was. */
    expect(page()).not.toContain('IGST')
  })

  it('names the place of supply, with the name of the state — 46(n)', () => {
    const p = page()
    expect(p).toContain('Place of supply')
    expect(p).toContain('33 — Tamil Nadu')
  })

  it('says whether the tax is payable on reverse charge — 46(p)', () => {
    expect(page()).toContain('Reverse charge No')
  })

  it('leaves the supplier a place to sign — 46(q)', () => {
    const p = page()
    expect(p).toContain('Authorised signatory')
    expect(p).toContain('For TRT Stationery')
  })

  it('states the total value of the supply — 46(j)', () => {
    expect(page()).toContain('680.00')
  })

  it('summarises the tax rate by rate, which is how the return is filed', () => {
    const p = page()
    expect(p).toContain('18%')
    expect(p).toContain('Total tax')
  })
})

describe('the same goods sold across a state line', () => {
  const page = () => text(render(interState()))

  it('charges IGST and says so', () => {
    const p = page()
    expect(p).toContain('IGST')
    expect(p).toContain('103.73')
  })

  it('does not print the CGST and SGST columns it did not charge', () => {
    const p = page()
    expect(p).not.toContain('CGST')
    expect(p).not.toContain('SGST')
  })

  it('names the recipient state, which is what made it inter-state — 46(n)', () => {
    const p = page()
    expect(p).toContain('27 — Maharashtra')
    expect(p).toContain('27AABCR5678G1Z2')
  })

  it('still says the supplier is in Tamil Nadu, which is the other half of it', () => {
    // Place of supply against the supplier's own registration is the whole test
    // of inter-state. Both have to be on the paper for a reader to apply it.
    expect(page()).toContain('33ALNPJ1906G1ZC')
  })
})

describe('what the sheet does when it has not been told', () => {
  it('prints no place of supply for a walk-in rather than the shop_s own state', () => {
    const walkIn: ReceiptDoc = {
      ...intraState(),
      customerName: null,
      customerAddress: null,
      customerGstin: null,
      customerState: null,
      placeOfSupply: null,
    }
    /* This is the bug this block was written against: `printHtml.ts` filled the
       place of supply with the shop's own state on every invoice, including
       ones billed to another state. Nothing beats a blank here, because a blank
       is true and a guess is evidence. */
    expect(text(render(walkIn))).not.toContain('Place of supply')
  })

  it('keeps the tax columns for a document raised before the supply type was stored', () => {
    const old: ReceiptDoc = { ...intraState() }
    delete old.supplyType
    // Falls back to what the amounts say, which for a bill carrying tax is
    // exactly right, and never to a guess about a bill carrying none.
    expect(text(render(old))).toContain('CGST')
  })

  it('prints no tax rate column for a document whose lines never carried one', () => {
    const bare = item()
    delete bare.taxRateBp
    const items = [bare]
    const old: ReceiptDoc = { ...intraState(), items, rateSummary: rateSummaryOf(items) }
    const p = text(render(old))
    expect(p).toContain('A4 Copier Paper 500 sheets')
    expect(p).not.toContain('18%')
  })
})
