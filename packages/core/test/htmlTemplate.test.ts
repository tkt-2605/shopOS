import { describe, it, expect } from 'vitest'
import {
  checkTemplate, renderTemplate, templateData, STARTER_TEMPLATE, TEMPLATE_TOKENS,
} from '../src/domain/htmlTemplate.js'
import { buildInvoiceHtml } from '../src/domain/invoiceHtml.js'
import { STANDARD_INVOICE, checkFormat, usesTemplate } from '../src/domain/docFormat.js'
import { fromUnits } from '../src/quantity.js'
import { paise, type Money } from '../src/money.js'
import type { ReceiptDoc } from '../src/domain/receipt.js'

/**
 * The shop's own A4 markup.
 *
 * The blocks were chosen over a template language for the roll and that
 * reasoning still holds there. This is the sheet, where it does not — and the
 * price of allowing it is that the three things below have to be true every
 * time: nothing executes, nothing is fetched, and a typo is caught on the
 * screen rather than on a customer's invoice.
 */

const doc: ReceiptDoc = {
  shop: {
    name: 'Muruga Stores',
    address: '14 Bazaar Street, Madurai',
    phone: '9847778899',
    email: 'shop@example.test',
    gstin: '33ABCDE1234F1Z5',
  },
  docNo: 'INV/MR/26-27/00023',
  postingDate: '2026-09-14',
  cashier: 'admin',
  customerName: 'Sri Vidya School',
  items: [
    {
      name: 'A4 Copier Paper', qty: fromUnits(2), saleUnit: 'ream',
      rate: paise(34000), lineTotal: paise(68000), hsnCode: '4802',
      taxableValue: paise(57627), cgst: paise(5186), sgst: paise(5187), igst: 0 as Money,
    },
    {
      name: 'Ball Pen Blue', qty: fromUnits(12), saleUnit: 'piece',
      rate: paise(1000), lineTotal: paise(12000), mrp: paise(1200),
    },
  ],
  subtotal: paise(80000),
  discount: 0 as Money,
  taxableTotal: paise(67797),
  cgst: paise(6101),
  sgst: paise(6101),
  igst: 0 as Money,
  grandTotal: paise(80000),
  payments: [{ method: 'cash', amount: paise(80000) }],
  terms: 'Goods once sold are not taken back.',
}

function render(source: string): string {
  const out = renderTemplate(source, templateData(doc))
  if (out === null) throw new Error(`refused: ${JSON.stringify(checkTemplate(source))}`)
  return out
}

describe('what a template may say', () => {
  it('puts the shop’s own facts where the shop asked for them', () => {
    expect(render('<p>{{shop.name}} — {{doc.no}}</p>'))
      .toBe('<p>Muruga Stores — INV/MR/26-27/00023</p>')
  })

  it('repeats the item section once per line, and once only', () => {
    const out = render('{{#items}}<li>{{item.no}} {{item.name}} {{item.amount}}</li>{{/items}}')
    expect(out).toBe('<li>1 A4 Copier Paper 680.00</li><li>2 Ball Pen Blue 120.00</li>')
  })

  it('reaches the document’s own facts from inside a line', () => {
    expect(render('{{#items}}[{{shop.name}}]{{/items}}')).toBe('[Muruga Stores][Muruga Stores]')
  })

  it('drops the whole row when the fact is not there', () => {
    // The second line carries no HSN, so the span must not be printed empty.
    const out = render('{{#items}}<td>{{#if item.hsn}}HSN {{item.hsn}}{{/if}}</td>{{/items}}')
    expect(out).toBe('<td>HSN 4802</td><td></td>')
  })

  it('has an “only when it is missing” form, for the fallback line', () => {
    expect(render('{{^if customer.gstin}}Unregistered{{/if}}')).toBe('Unregistered')
    expect(render('{{^if customer.name}}Walk-in{{/if}}')).toBe('')
  })

  it('repeats the payments section the same way', () => {
    expect(render('{{#payments}}{{payment.method}}={{payment.amount}}{{/payments}}'))
      .toBe('Cash=800.00')
  })
})

describe('what a template is not allowed to do', () => {
  it('refuses a script outright rather than stripping it', () => {
    expect(checkTemplate('<p>hi</p><script>alert(1)</script>'))
      .toContainEqual({ code: 'SCRIPT' })
    expect(renderTemplate('<script>alert(1)</script>', templateData(doc))).toBeNull()
  })

  it('refuses an event handler, which is a script by another spelling', () => {
    expect(checkTemplate('<img src="x" onerror="alert(1)">'))
      .toContainEqual({ code: 'HANDLER', name: 'onerror' })
  })

  it('refuses a javascript: link', () => {
    expect(checkTemplate('<a href="javascript:alert(1)">x</a>')).toContainEqual({ code: 'SCRIPT' })
  })

  it('refuses anything fetched off the device, because the shop prints offline', () => {
    expect(checkTemplate('<img src="https://tracker.example/pixel.gif">'))
      .toContainEqual({ code: 'OFF_DEVICE', url: 'https://tracker.example/pixel.gif' })
    expect(checkTemplate('<style>@import url(//fonts.example/x.css);</style>')[0]?.code)
      .toBe('OFF_DEVICE')
  })

  it('allows the shop’s own logo, which is carried in the file and not fetched', () => {
    expect(checkTemplate('{{#if shop.logo}}<img src="{{shop.logo}}">{{/if}}')).toEqual([])
  })
})

describe('what a template is told about its mistakes', () => {
  it('names a token that does not exist instead of printing a hole', () => {
    expect(checkTemplate('<p>{{shop.nmae}}</p>'))
      .toContainEqual({ code: 'UNKNOWN_TOKEN', name: 'shop.nmae' })
  })

  it('names a section that was opened and never closed', () => {
    expect(checkTemplate('{{#items}}<li>{{item.name}}</li>'))
      .toContainEqual({ code: 'UNCLOSED', name: 'items' })
  })

  it('names a closing tag with nothing open', () => {
    expect(checkTemplate('<p>x</p>{{/items}}')).toContainEqual({ code: 'UNOPENED', name: 'items' })
  })

  it('refuses a per-line token used where there is no line', () => {
    expect(checkTemplate('<p>{{item.name}}</p>'))
      .toContainEqual({ code: 'TOKEN_OUT_OF_SECTION', name: 'item.name', section: 'items' })
  })

  it('reports every fault at once, not one per save', () => {
    const problems = checkTemplate('{{shop.nmae}} {{#items}}{{item.nmae}}')
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })

  it('escapes a value that would otherwise break the page', () => {
    const awkward: ReceiptDoc = { ...doc, customerName: 'Smith <Retail> & Co' }
    const out = renderTemplate('<p>{{customer.name}}</p>', templateData(awkward))
    expect(out).toBe('<p>Smith &lt;Retail&gt; &amp; Co</p>')
  })
})

describe('the starting point', () => {
  it('is fit to print exactly as it is handed over', () => {
    expect(checkTemplate(STARTER_TEMPLATE)).toEqual([])
  })

  it('produces a page carrying the shop, the lines and the total', () => {
    const out = render(STARTER_TEMPLATE)
    expect(out).toContain('Muruga Stores')
    expect(out).toContain('A4 Copier Paper')
    expect(out).toContain('Ball Pen Blue')
    expect(out).toContain('800.00')
    expect(out).toContain('Rupees Eight Hundred Only')
  })

  it('uses only tokens the catalogue documents', () => {
    // The screen lists TEMPLATE_TOKENS; a starter reaching past that list would
    // be teaching a shop a name the reference page does not have.
    const used = [...STARTER_TEMPLATE.matchAll(/\{\{\s*(?:#if|\^if)?\s*([a-z0-9_.]+)\s*\}\}/gi)]
      .map((m) => m[1]!)
      .filter((name) => !['items', 'payments', 'if'].includes(name))
    const known = new Set(TEMPLATE_TOKENS.map((t) => t.token))
    expect([...new Set(used)].filter((name) => !known.has(name))).toEqual([])
  })
})

describe('a format that carries one', () => {
  const withTemplate = { ...STANDARD_INVOICE, template: '<p>{{doc.no}}</p>' }

  it('prints the shop’s markup instead of the blocks', () => {
    const html = buildInvoiceHtml(doc, withTemplate)
    expect(html).toContain('<p>INV/MR/26-27/00023</p>')
    // The blocks' own item table is not in it.
    expect(html).not.toContain('class="items"')
  })

  it('keeps the page box and the margins, which are not the shop’s to lose', () => {
    const html = buildInvoiceHtml(doc, withTemplate)
    expect(html).toContain('@page { size: A4; margin: 0; }')
    expect(html).toContain('class="edge"')
  })

  it('falls back to the blocks rather than printing a broken page', () => {
    const broken = { ...STANDARD_INVOICE, template: '{{#items}}<li>{{item.name}}' }
    const html = buildInvoiceHtml(doc, broken)
    expect(html).toContain('class="items"')
  })

  it('is refused at the save, so nobody reaches the printer to find out', () => {
    const problems = checkFormat({ ...STANDARD_INVOICE, template: '<p>{{shop.nmae}}</p>' })
    expect(problems).toContainEqual({
      code: 'TEMPLATE', problem: { code: 'UNKNOWN_TOKEN', name: 'shop.nmae' },
    })
  })

  it('is refused on a roll, which has no HTML anywhere in its path', () => {
    expect(checkFormat({
      name: 'Till', paper: 'thermal_80', blocks: STANDARD_INVOICE.blocks, template: '<p>x</p>',
    })).toContainEqual({ code: 'TEMPLATE_ON_ROLL' })
  })

  it('goes back to the blocks when the template is cleared', () => {
    expect(usesTemplate({ paper: 'a4', template: '   ' })).toBe(false)
    expect(usesTemplate({ paper: 'a4', template: '<p>x</p>' })).toBe(true)
    expect(usesTemplate({ paper: 'thermal_80', template: '<p>x</p>' })).toBe(false)
  })

  it('leaves a format with no template printing exactly as it did', () => {
    expect(buildInvoiceHtml(doc, STANDARD_INVOICE)).toContain('class="items"')
  })
})
