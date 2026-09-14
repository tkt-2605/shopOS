import { format as fmtMoney } from '../money.js'
import { formatQty } from '../quantity.js'
import { BILL_WORDING, type DocWording, type ReceiptDoc, type ReceiptItem } from './receipt.js'
import { fillTokens, PAPER, type Block, type DocFormat, type Facts } from './docFormat.js'

/**
 * The same document, on a sheet.
 *
 * HTML rather than another hand-written PDF writer. `pdf.rs` carries the
 * standard fourteen fonts, which are WinAnsi — no Tamil, no ₹ — and teaching a
 * hand-rolled writer to embed a subsetted CID font is a job in its own right.
 * The webview already has fonts, Unicode and a layout engine, so an invoice
 * rendered here can say ₹ and can say a customer's name in Tamil today.
 *
 * It walks the same blocks as the thermal renderer, in the same order, honouring
 * the same switches — so a shop that turns the footer off turns it off on both
 * papers. What differs is only what a sheet can afford: a real table with a
 * column per tax, the shop and the invoice side by side, a signature block.
 *
 * Pure, like `receipt.ts`: a string in, a string out, no printer and no DOM.
 */

/** The white edge of the paper, as padding rather than as a page margin. */
const MARGIN = '14mm'

export interface InvoiceHtmlOptions {
  /** Adds the print dialog call, for the window that is about to print itself. */
  autoPrint?: boolean
  /** Marks the page as a preview: no page box, so it sits inside a frame. */
  preview?: boolean
}

export function buildInvoiceHtml(
  doc: ReceiptDoc,
  format: DocFormat,
  options: InvoiceHtmlOptions = {},
): string {
  const spec = PAPER[format.paper]
  const pageSize = spec.kind === 'sheet' ? spec.css : 'A4'

  const body = format.blocks
    .filter((b) => b.on)
    .map((b) => renderBlock(b, doc))
    .filter((html) => html !== '')
    .join('\n')

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${esc(doc.docNo)}</title>`,
    `<style>${styles(pageSize, options.preview ?? false)}</style>`,
    '</head><body>',
    // The spacer rows are what put a margin on the second and later pages; see
    // `styles`. A `thead` repeats at the top of every printed page and a `tfoot`
    // at the bottom of every one, which is the only way to reserve the same
    // strip on each page once `@page` has given its margin up.
    '<table class="page"><thead><tr><td><div class="edge"></div></td></tr></thead>',
    `<tbody><tr><td><main class="sheet">${body}</main></td></tr></tbody>`,
    '<tfoot><tr><td><div class="edge"></div></td></tr></tfoot></table>',
    options.autoPrint ? '<script>window.onload=function(){window.print()}</script>' : '',
    '</body></html>',
  ].join('')
}

function renderBlock(block: Block, doc: ReceiptDoc): string {
  switch (block.kind) {
    case 'shop':
      return `<header class="shop">
        <div class="shop-name">${esc(doc.shop.name)}</div>
        ${line(doc.shop.address)}
        ${doc.shop.phone ? line(`Phone ${doc.shop.phone}`) : ''}
        ${doc.shop.gstin ? line(`GSTIN ${doc.shop.gstin}`) : ''}
      </header>`

    case 'title': {
      /* A document that knows what it is outranks the wording the shop chose,
         which was chosen for its bills. A bill carries no wording and keeps it. */
      const label = doc.wording?.title ?? block.opts?.label?.trim()
      return label ? `<h1 class="title">${esc(label)}</h1>` : ''
    }

    case 'meta':
      return `<table class="meta"><tbody>
        <tr><th>${esc(wordsFor(doc).docNo)}</th><td>${esc(doc.docNo)}</td></tr>
        <tr><th>Date</th><td>${esc(formatDate(doc.postingDate))}</td></tr>
        ${doc.validUntil ? `<tr><th>Valid until</th><td>${esc(formatDate(doc.validUntil))}</td></tr>` : ''}
        ${doc.placeOfSupply ? `<tr><th>Place of supply</th><td>${esc(doc.placeOfSupply)}</td></tr>` : ''}
        ${doc.cashier ? `<tr><th>${esc(wordsFor(doc).by)}</th><td>${esc(doc.cashier)}</td></tr>` : ''}
      </tbody></table>`

    case 'party': {
      if (!doc.customerName) return ''
      return `<section class="party">
        <div class="party-label">${esc(wordsFor(doc).party)}</div>
        <div class="party-name">${esc(doc.customerName)}</div>
        ${line(doc.customerAddress)}
        ${doc.customerGstin ? line(`GSTIN ${doc.customerGstin}`) : ''}
      </section>`
    }

    case 'items': {
      // The tax columns earn their place only when the lines carry the numbers.
      const taxed = doc.items.some((i) => i.taxableValue !== undefined)
      const hsn = doc.items.some((i) => i.hsnCode)

      return `<table class="items"><thead><tr>
        <th class="c-no">#</th>
        <th class="c-name">Item</th>
        ${hsn ? '<th class="c-hsn">HSN</th>' : ''}
        <th class="c-num">Qty</th>
        <th class="c-num">Rate</th>
        ${taxed ? '<th class="c-num">Taxable</th><th class="c-num">Tax</th>' : ''}
        <th class="c-num">Amount</th>
      </tr></thead><tbody>
        ${doc.items.map((item, i) => itemRow(item, i, { hsn, taxed })).join('')}
      </tbody></table>`
    }

    case 'totals': {
      const rows = [row('Subtotal', doc.subtotal)]
      if (doc.discount > 0) rows.push(row('Discount', doc.discount, '-'))
      rows.push(row('Taxable value', doc.taxableTotal))
      if (doc.cgst > 0) rows.push(row('CGST', doc.cgst))
      if (doc.sgst > 0) rows.push(row('SGST', doc.sgst))
      if (doc.igst > 0) rows.push(row('IGST', doc.igst))

      return `<table class="totals"><tbody>
        ${rows.join('')}
        <tr class="grand"><th>Total</th><td>${esc(fmtMoney(doc.grandTotal))}</td></tr>
      </tbody></table>`
    }

    case 'tax_summary': {
      if (doc.cgst === 0 && doc.sgst === 0 && doc.igst === 0) return ''
      return `<table class="tax"><thead><tr>
          <th>Taxable value</th>
          ${doc.cgst > 0 ? '<th class="c-num">CGST</th>' : ''}
          ${doc.sgst > 0 ? '<th class="c-num">SGST</th>' : ''}
          ${doc.igst > 0 ? '<th class="c-num">IGST</th>' : ''}
        </tr></thead><tbody><tr>
          <td>${esc(fmtMoney(doc.taxableTotal))}</td>
          ${doc.cgst > 0 ? `<td class="c-num">${esc(fmtMoney(doc.cgst))}</td>` : ''}
          ${doc.sgst > 0 ? `<td class="c-num">${esc(fmtMoney(doc.sgst))}</td>` : ''}
          ${doc.igst > 0 ? `<td class="c-num">${esc(fmtMoney(doc.igst))}</td>` : ''}
        </tr></tbody></table>`
    }

    case 'payments': {
      if (doc.payments.length === 0) return ''
      return `<table class="payments"><tbody>
        ${doc.payments.map((p) => row(titleCase(p.method), p.amount)).join('')}
      </tbody></table>`
    }

    case 'loyalty': {
      if (!doc.pointsEarned) return ''
      const balance = doc.pointsBalance === undefined
        ? ''
        : `, balance ${doc.pointsBalance}`
      return `<p class="note">Points earned ${doc.pointsEarned}${esc(balance)}</p>`
    }

    case 'terms': {
      const words = doc.terms ?? doc.footer
      return words ? `<p class="terms">${esc(words)}</p>` : ''
    }

    case 'signature':
      return `<section class="signature">
        <div class="sign-for">For ${esc(doc.shop.name)}</div>
        <div class="sign-rule"></div>
        <div class="sign-label">Authorised signatory</div>
      </section>`

    case 'text': {
      const body = block.opts?.body?.trim()
      return body ? `<p class="note">${esc(fillTokens(body, factsFor(doc)))}</p>` : ''
    }

    case 'space':
      return `<div class="space" style="height:${Math.min(Math.max(block.opts?.lines ?? 1, 1), 6) * 1.4}em"></div>`

    /* Neither has a renderer on either paper yet, and `checkFormat` refuses to
       save a format with one switched on. */
    case 'logo':
    case 'amount_in_words':
      return ''
  }
}

function itemRow(item: ReceiptItem, index: number, has: { hsn: boolean; taxed: boolean }): string {
  const tax = (item.cgst ?? 0) + (item.sgst ?? 0) + (item.igst ?? 0)
  return `<tr>
    <td class="c-no">${index + 1}</td>
    <td class="c-name">${esc(item.name)}</td>
    ${has.hsn ? `<td class="c-hsn">${esc(item.hsnCode ?? '')}</td>` : ''}
    <td class="c-num">${esc(`${formatQty(item.qty)} ${item.saleUnit}`)}</td>
    <td class="c-num">${esc(fmtMoney(item.rate))}</td>
    ${has.taxed ? `<td class="c-num">${esc(fmtMoney((item.taxableValue ?? 0) as never))}</td>` : ''}
    ${has.taxed ? `<td class="c-num">${esc(fmtMoney(tax as never))}</td>` : ''}
    <td class="c-num">${esc(fmtMoney(item.lineTotal))}</td>
  </tr>`
}

function row(label: string, amount: number, sign = ''): string {
  return `<tr><th>${esc(label)}</th><td>${esc(sign + fmtMoney(amount as never))}</td></tr>`
}

function line(text: string | null | undefined): string {
  return text ? `<div>${esc(text)}</div>` : ''
}

function factsFor(doc: ReceiptDoc): Facts {
  return {
    'shop.name': doc.shop.name,
    'shop.address': doc.shop.address ?? '',
    'shop.phone': doc.shop.phone ?? '',
    'shop.gstin': doc.shop.gstin ?? '',
    'doc.no': doc.docNo,
    'doc.date': formatDate(doc.postingDate),
    'customer.name': doc.customerName ?? '',
    total: fmtMoney(doc.grandTotal),
  }
}

/**
 * The page never receives anything but the shop's own data — but a product name
 * with an ampersand in it would still break the markup, and a shop is free to
 * type anything into a text block. Escaped at the one place values become HTML.
 */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/**
 * Printed styling, inline because the page is handed whole to a print window or
 * a preview frame and has nowhere to fetch a stylesheet from.
 *
 * No rounded corners, matching the rest of the product. `break-inside: avoid` on
 * the table rows is what keeps a line item from being sliced in half across a
 * page break, which is the failure that makes an invoice look unprofessional.
 */
function styles(pageSize: string, preview: boolean): string {
  return `
    /*
     * Zero, deliberately. A browser prints the page address, the date and
     * "1/1" into the @page margin box, and there is no stylesheet and no Tauri
     * API that switches those off — only an unticked box in a dialog the
     * shopkeeper should not have to find. With no margin there is nowhere for
     * them to be drawn, so the paper carries the invoice and nothing else.
     *
     * The margin then has to come back as padding, and padding on one element
     * only indents the first page. Hence the running spacer rows, which a
     * printing engine repeats on every page.
     */
    @page { size: ${pageSize}; margin: 0; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 11pt/1.45 'Segoe UI', system-ui, sans-serif;
      color: #111;
      background: ${preview ? '#fff' : 'transparent'};
    }
    .page { width: 100%; border-collapse: collapse; }
    .page > thead, .page > tfoot { break-inside: avoid; }
    .page > thead td, .page > tfoot td, .page > tbody td { padding: 0; }
    .edge { height: 0; }
    .sheet { padding: ${MARGIN}; }
    @media print {
      /* The strip the running rows hold open at the top and foot of each page. */
      .edge { height: ${MARGIN}; }
      .sheet { padding: 0 ${MARGIN}; }
    }
    .shop { margin-bottom: 10px; }
    .shop-name { font-size: 17pt; font-weight: 700; letter-spacing: -0.01em; }
    .shop div { font-size: 9.5pt; color: #444; }
    .title {
      margin: 14px 0 10px;
      padding: 6px 0;
      font-size: 12pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: center;
      border-top: 1px solid #111;
      border-bottom: 1px solid #111;
    }
    table { width: 100%; border-collapse: collapse; }
    .meta { width: auto; margin-bottom: 12px; font-size: 10pt; }
    .meta th { padding: 1px 14px 1px 0; font-weight: 400; color: #555; text-align: left; }
    .meta td { padding: 1px 0; font-weight: 600; }
    .party { margin-bottom: 12px; padding: 8px 10px; border: 1px solid #bbb; }
    .party-label { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #555; }
    .party-name { font-size: 11.5pt; font-weight: 700; }
    .party div { font-size: 9.5pt; color: #444; }
    .items { margin-bottom: 12px; font-size: 10pt; }
    .items thead th {
      padding: 5px 6px;
      font-size: 8.5pt;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      text-align: left;
      border-bottom: 1.5px solid #111;
    }
    .items tbody td { padding: 5px 6px; border-bottom: 1px solid #ddd; }
    .items tbody tr { break-inside: avoid; }
    .c-no { width: 26px; }
    .c-hsn { width: 62px; }
    .c-num { text-align: right; white-space: nowrap; }
    th.c-num { text-align: right; }
    .totals, .payments { width: 46%; margin-left: auto; font-size: 10pt; }
    .totals th, .payments th { padding: 2px 6px; font-weight: 400; color: #444; text-align: left; }
    .totals td, .payments td { padding: 2px 6px; text-align: right; white-space: nowrap; }
    .totals .grand th, .totals .grand td {
      padding-top: 5px;
      font-size: 12pt;
      font-weight: 700;
      color: #111;
      border-top: 1.5px solid #111;
    }
    .payments { margin-top: 10px; }
    .payments th, .payments td { color: #555; }
    .tax { margin: 12px 0; font-size: 9.5pt; }
    .tax th, .tax td { padding: 4px 6px; border: 1px solid #bbb; text-align: left; }
    .tax thead th { background: #f2f2f2; }
    .note { margin: 8px 0 0; font-size: 9.5pt; color: #555; }
    .terms { margin: 16px 0 0; padding-top: 8px; font-size: 9pt; color: #555; border-top: 1px solid #ddd; }
    .signature { margin-top: 34px; width: 210px; margin-left: auto; text-align: center; break-inside: avoid; }
    .sign-for { font-size: 9.5pt; color: #444; }
    .sign-rule { margin-top: 40px; border-top: 1px solid #111; }
    .sign-label { margin-top: 3px; font-size: 8.5pt; color: #555; }
  `
}

/** What this kind of document calls its number, its party and its author. */
function wordsFor(doc: ReceiptDoc): DocWording {
  return doc.wording ?? BILL_WORDING
}
