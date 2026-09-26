import { format as fmtMoney, inWords } from '../money.js'
import { formatQty } from '../quantity.js'
import {
  BILL_WORDING, formatRate,
  type DocWording, type ReceiptDoc, type ReceiptItem,
} from './receipt.js'
import { fillTokens, PAPER, usesTemplate, type Block, type DocFormat } from './docFormat.js'
import { renderTemplate, templateData } from './htmlTemplate.js'
import { factsFor, escapeHtml as esc, titleCase, formatDate } from './docText.js'

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
  /**
   * Marks the page as a preview: no page box, so it sits inside a frame.
   */
  preview?: boolean
}

export function buildInvoiceHtml(
  doc: ReceiptDoc,
  format: DocFormat,
  options: InvoiceHtmlOptions = {},
): string {
  const spec = PAPER[format.paper]
  const pageSize = spec.kind === 'sheet' ? spec.css : 'A4'

  /* The shop's own markup, when it has written some. `renderTemplate` answers
     null for a template with a fault in it, and then the blocks are what prints
     — a bill that looks like the standard one beats a bill with a hole in it,
     and the designer is where a shop is told which of the two it is getting. */
  const own = usesTemplate(format) ? renderTemplate(format.template!, templateData(doc)) : null

  const body = own ?? format.blocks
    .filter((b) => b.on)
    .map((b) => renderBlock(b, doc))
    .filter((html) => html !== '')
    .join('\n')

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${esc(doc.docNo)}</title>`,
    /* The shop's own page still gets the page box, the margin trick and a plain
       set of defaults to build on. What it does not get is the block layout's
       own classes, which its markup does not use. */
    `<style>${styles(pageSize, options.preview ?? false)}</style>`,
    '</head><body>',
    // The spacer rows are what put a margin on the second and later pages; see
    // `styles`. A `thead` repeats at the top of every printed page and a `tfoot`
    // at the bottom of every one, which is the only way to reserve the same
    // strip on each page once `@page` has given its margin up.
    '<table class="page"><thead><tr><td><div class="edge"></div></td></tr></thead>',
    // `blocks` only when the blocks laid it out: the grid below is theirs, and
    // a shop's own markup keeps the plain sheet it was written against.
    `<tbody><tr><td><main class="${own === null ? 'sheet blocks' : 'sheet'}">${body}</main></td></tr></tbody>`,
    '<tfoot><tr><td><div class="edge"></div></td></tr></tfoot></table>',
    /* Nothing here opens the print dialog, and that is the fix for a bill that
       asked to be printed twice.

       This used to inject `window.onload = () => window.print()` under an
       `autoPrint` option. Every caller that passed it then handed the result to
       `printHtml`, which lays the page out in a frame and calls `print()` on it
       — so the document printed itself *and* was printed, and a shopkeeper got
       two dialogs and had to dismiss two.

       The page is a document and not a program. Whoever is showing it decides
       when it prints: the frame does it for a print, and the preview window
       does it when somebody presses the button on it. Neither needs the page's
       help, and the page cannot tell which of them it is in. */
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
      if (!label) return ''
      // Rule 49's statement belongs with the title it qualifies, not in the
      // footer where a reader has stopped looking.
      return `<h1 class="title">${esc(label)}</h1>${
        doc.schemeStatement ? `<p class="scheme">${esc(doc.schemeStatement)}</p>` : ''}`
    }

    case 'meta':
      return `<table class="meta"><tbody>
        <tr><th>${esc(wordsFor(doc).docNo)}</th><td>${esc(doc.docNo)}</td></tr>
        <tr><th>Date</th><td>${esc(formatDate(doc.postingDate))}</td></tr>
        ${doc.againstDocNo ? `<tr><th>Against invoice</th><td>${esc(doc.againstDocNo)}${
          doc.againstDate ? esc(` dated ${formatDate(doc.againstDate)}`) : ''}</td></tr>` : ''}
        ${doc.validUntil ? `<tr><th>Valid until</th><td>${esc(formatDate(doc.validUntil))}</td></tr>` : ''}
        ${doc.placeOfSupply
          ? `<tr><th>Place of supply</th><td>${esc(placeLabel(doc.placeOfSupply))}</td></tr>` : ''}
        ${/* Rule 46(p). Always "No" in this product, and said rather than left
              for the reader to assume. */ ''}
        ${doc.reverseCharge === undefined
          ? '' : `<tr><th>Reverse charge</th><td>${doc.reverseCharge ? 'Yes' : 'No'}</td></tr>`}
        ${doc.cashier ? `<tr><th>${esc(wordsFor(doc).by)}</th><td>${esc(doc.cashier)}</td></tr>` : ''}
      </tbody></table>`

    case 'party': {
      if (!doc.customerName) return ''
      return `<section class="party">
        <div class="party-label">${esc(wordsFor(doc).party)}</div>
        <div class="party-name">${esc(doc.customerName)}</div>
        ${line(doc.customerAddress)}
        ${doc.customerState ? line(placeLabel(doc.customerState)) : ''}
        ${doc.customerGstin ? line(`GSTIN ${doc.customerGstin}`) : ''}
      </section>`
    }

    case 'items': {
      const has = columnsFor(doc)

      return `<table class="items"><thead><tr>
        <th class="c-no">#</th>
        <th class="c-name">Item</th>
        ${has.hsn ? '<th class="c-hsn">HSN</th>' : ''}
        <th class="c-num">Qty</th>
        <th class="c-num">Rate</th>
        ${has.taxed ? '<th class="c-num">Taxable</th>' : ''}
        ${has.rate ? '<th class="c-num">GST</th>' : ''}
        ${has.halves ? '<th class="c-num">CGST</th><th class="c-num">SGST</th>' : ''}
        ${has.igst ? '<th class="c-num">IGST</th>' : ''}
        <th class="c-num">Amount</th>
      </tr></thead><tbody>
        ${doc.items.map((item, i) => itemRow(item, i, has)).join('')}
      </tbody></table>`
    }

    case 'totals': {
      const rows = [row('Subtotal', doc.subtotal)]
      if (doc.discount > 0) rows.push(row('Discount', doc.discount, '-'))
      // Same reasoning as the roll: not on a document that charged no tax and
      // took nothing off, where it is the subtotal again under a wrong heading.
      if (columnsFor(doc).taxed || doc.taxableTotal !== doc.subtotal) {
        rows.push(row('Taxable value', doc.taxableTotal))
      }
      if (doc.cgst > 0) rows.push(row('CGST', doc.cgst))
      if (doc.sgst > 0) rows.push(row('SGST', doc.sgst))
      if (doc.igst > 0) rows.push(row('IGST', doc.igst))
      /* Only when there is one. A "Round off 0.00" line on an invoice that was
         never rounded is a line that raises a question and answers nothing. */
      if (doc.roundOff) rows.push(row('Round off', Math.abs(doc.roundOff), doc.roundOff < 0 ? '-' : '+'))

      return `<table class="totals"><tbody>
        ${rows.join('')}
        <tr class="grand"><th>Total</th><td>${esc(fmtMoney(doc.grandTotal))}</td></tr>
      </tbody></table>`
    }

    case 'tax_summary': {
      if (doc.cgst === 0 && doc.sgst === 0 && doc.igst === 0) return ''

      /* Rate by rate when the document carries its rates, which is the block a
         CA reads first and the shape a GST return is filed in. One row without
         a rate is what a document raised before the rates were stored gets —
         the old single row, rather than a summary that invents a rate. */
      const has = columnsFor(doc)
      const rows = doc.rateSummary && doc.rateSummary.length > 0
        ? doc.rateSummary
        : [{ rateBp: -1, taxable: doc.taxableTotal, cgst: doc.cgst, sgst: doc.sgst, igst: doc.igst }]

      const body = rows.map((r) => `<tr>
          ${r.rateBp < 0 ? '<td>Total</td>' : `<td>${esc(formatRate(r.rateBp))}</td>`}
          <td class="c-num">${esc(fmtMoney(r.taxable))}</td>
          ${has.halves ? `<td class="c-num">${esc(fmtMoney(r.cgst))}</td>` : ''}
          ${has.halves ? `<td class="c-num">${esc(fmtMoney(r.sgst))}</td>` : ''}
          ${has.igst ? `<td class="c-num">${esc(fmtMoney(r.igst))}</td>` : ''}
          <td class="c-num">${esc(fmtMoney((r.cgst + r.sgst + r.igst) as never))}</td>
        </tr>`).join('')

      return `<table class="tax"><thead><tr>
          <th>GST</th>
          <th class="c-num">Taxable value</th>
          ${has.halves ? '<th class="c-num">CGST</th><th class="c-num">SGST</th>' : ''}
          ${has.igst ? '<th class="c-num">IGST</th>' : ''}
          <th class="c-num">Total tax</th>
        </tr></thead><tbody>${body}</tbody></table>`
    }

    case 'payments': {
      if (doc.payments.length === 0) return ''
      return `<table class="payments"><tbody>
        ${doc.payments.map((p) => row(methodLabel(p.method), p.amount)).join('')}
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

    case 'amount_in_words':
      return `<p class="words"><span class="k">Amount in words</span>${esc(inWords(doc.grandTotal))}</p>`

    case 'logo': {
      const logo = doc.shop.logo
      /* Nothing rather than a broken-image box: a shop that has not uploaded a
         mark yet still prints bills, and the gap where one would go is not
         something a customer should be shown. */
      if (!logo || !SAFE_DATA_URI.test(logo)) return ''
      const height = Math.min(Math.max(block.opts?.height ?? 18, 6), 40)
      return `<div class="logo"><img src="${logo}" style="height:${height}mm" alt=""></div>`
    }
  }
}

/**
 * What may go in an `src` attribute unescaped.
 *
 * A data URI of base64 has no quote, no angle bracket and no space in it, so
 * one that matches this cannot close the attribute and start an element of its
 * own. Anything else is refused rather than escaped: an image reference is not
 * a place to be clever about untrusted text.
 */
const SAFE_DATA_URI = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/

interface Columns {
  hsn: boolean
  taxed: boolean
  rate: boolean
  halves: boolean
  igst: boolean
}

/**
 * Which tax columns the sheet prints.
 *
 * CGST and SGST together, or IGST alone — never all three, and never a column
 * of zeroes. An invoice with an empty IGST column beside a filled CGST one asks
 * the reader to work out which kind of supply it was; saying it once, in the
 * columns and again as the place of supply, is the whole point of Rule 46(m).
 *
 * `supplyType` decides it where the bill recorded one, and the amounts decide
 * it where it did not. The difference matters for a bill of entirely exempt
 * goods: every figure is zero, so the amounts say nothing, and only the stored
 * supply type can tell an exempt local sale from an exempt inter-state one.
 */
function columnsFor(doc: ReceiptDoc): Columns {
  /* No tax anywhere means no tax columns, not columns of zeroes. On a bill of
     supply that is the whole point: a composition dealer may not charge tax,
     and a document of theirs showing a CGST column -- even an empty one -- is
     making the claim Rule 49 exists to stop them making. The taxable column
     goes with it, because with nothing taken out of it the taxable value is the
     amount, printed twice under two headings, one of which is wrong. */
  const charged = doc.cgst > 0 || doc.sgst > 0 || doc.igst > 0
  const taxed = charged && doc.items.some((i) => i.taxableValue !== undefined)
  const inter = doc.supplyType !== undefined
    ? doc.supplyType === 'inter_state'
    : doc.igst > 0

  return {
    hsn: doc.items.some((i) => i.hsnCode),
    taxed,
    rate: taxed && doc.items.some((i) => i.taxRateBp !== undefined),
    halves: taxed && !inter,
    igst: taxed && inter,
  }
}

function itemRow(item: ReceiptItem, index: number, has: Columns): string {
  return `<tr>
    <td class="c-no">${index + 1}</td>
    <td class="c-name">${esc(item.name)}</td>
    ${has.hsn ? `<td class="c-hsn">${esc(item.hsnCode ?? '')}</td>` : ''}
    <td class="c-num">${esc(`${formatQty(item.qty)} ${item.saleUnit}`)}</td>
    <td class="c-num">${esc(fmtMoney(item.rate))}</td>
    ${has.taxed ? `<td class="c-num">${esc(fmtMoney((item.taxableValue ?? 0) as never))}</td>` : ''}
    ${has.rate ? `<td class="c-num">${esc(item.taxRateBp === undefined ? '' : formatRate(item.taxRateBp))}</td>` : ''}
    ${has.halves ? `<td class="c-num">${esc(fmtMoney((item.cgst ?? 0) as never))}</td>` : ''}
    ${has.halves ? `<td class="c-num">${esc(fmtMoney((item.sgst ?? 0) as never))}</td>` : ''}
    ${has.igst ? `<td class="c-num">${esc(fmtMoney((item.igst ?? 0) as never))}</td>` : ''}
    <td class="c-num">${esc(fmtMoney(item.lineTotal))}</td>
  </tr>`
}

/** "27 — Maharashtra": the code a return is filed with, and the name a person reads. */
function placeLabel(place: { code: string; name: string }): string {
  return place.code && place.name ? `${place.code} — ${place.name}` : place.name || place.code
}

function row(label: string, amount: number, sign = ''): string {
  return `<tr><th>${esc(label)}</th><td>${esc(sign + fmtMoney(amount as never))}</td></tr>`
}

function line(text: string | null | undefined): string {
  return text ? `<div>${esc(text)}</div>` : ''
}

/** A tender as it is written: UPI is an acronym, not a word to capitalise. */
function methodLabel(method: string): string {
  return method === 'upi' ? 'UPI' : titleCase(method)
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
    /* Child combinators all the way down. ".page > tbody td" reached every cell
       of every table on the sheet and outranked ".tax td", which is why the
       tax summary always printed with its figures against the rules. */
    .page > thead > tr > td, .page > tfoot > tr > td, .page > tbody > tr > td { padding: 0; }
    .edge { height: 0; }
    .sheet { padding: ${MARGIN}; }
    @media print {
      /* The strip the running rows hold open at the top and foot of each page. */
      .edge { height: ${MARGIN}; }
      .sheet { padding: 0 ${MARGIN}; }
    }
    /* The sheet is a two-column grid, and every block spans both unless it is
       one of the pairs an invoice reads side by side: the document's details
       beside the customer, and the tax table beside the totals. The blocks keep
       the order the shop gave them; only their width is decided here, so a shop
       that moves or switches a block off gets a sheet that still lines up.

       Everything that carries a tint says so to the printer. A print dialog
       drops background colour unless asked, and the grey bands are what make
       the columns and the total findable at arm's length. */
    .blocks {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      column-gap: 7mm;
      align-items: start;
      /* Dense, so a half-width block fills the cell beside the one above it --
         the amount in words beside the payments -- instead of starting a row. */
      grid-auto-flow: row dense;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      font-variant-numeric: tabular-nums;
    }
    .blocks > * { grid-column: 1 / -1; }
    .blocks > .meta, .blocks > .tax, .blocks > .words { grid-column: 1; }
    .blocks > .party, .blocks > .totals, .blocks > .payments { grid-column: 2; }
    /* Centred, over a title band that is centred and a rule that runs the full
       width. This is the shape of every invoice an Indian shop already
       recognises, and it matches the thermal roll -- the roll and the sheet are
       the same shop's paper. */
    .shop { margin-bottom: 8px; text-align: center; }
    .shop-name { font-size: 18pt; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; }
    /* ".shop > div", not ".shop div": the name is a div too, and the wider
       selector outranked ".shop-name", so every invoice printed the shop's own
       name at the size of its phone number. */
    .shop > div:not(.shop-name) { font-size: 9.5pt; color: #444; }
    /* A logo above a centred name belongs on the same axis as the name. */
    .logo { margin: 0 0 6px; text-align: center; }
    .logo img { display: inline-block; max-width: 60mm; object-fit: contain; }
    .title {
      margin: 8px 0 12px;
      padding: 6px 0;
      font-size: 12pt;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      text-align: center;
      background: #f1f1f1;
      border-top: 1.5px solid #111;
      border-bottom: 1.5px solid #111;
    }
    .scheme { margin: -8px 0 12px; font-size: 9pt; text-align: center; color: #333; }
    table { width: 100%; border-collapse: collapse; }
    /* The two boxes of the details band, drawn the same so they read as a pair. */
    .meta, .party { margin-bottom: 12px; border: 1px solid #bbb; font-size: 10pt; }
    .meta th { padding: 4px 10px; width: 42%; font-weight: 400; color: #555; text-align: left; }
    .meta td { padding: 4px 10px; font-weight: 600; }
    .meta tr + tr th, .meta tr + tr td { border-top: 1px solid #eee; }
    .party { padding: 8px 10px; }
    .party-label {
      margin-bottom: 2px;
      font-size: 8pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #555;
    }
    .party-name { font-size: 11.5pt; font-weight: 700; }
    .party > div:not(.party-label):not(.party-name) { font-size: 9.5pt; color: #444; }
    .items { margin-bottom: 12px; font-size: 10pt; border: 1px solid #bbb; }
    .items thead th {
      padding: 6px;
      font-size: 8pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-align: left;
      background: #f1f1f1;
      border-bottom: 1.5px solid #111;
    }
    .items tbody td { padding: 5px 6px; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
    .items tbody tr:nth-child(even) td { background: #fafafa; }
    .items tbody tr:last-child td { border-bottom: 0; }
    .items tbody tr { break-inside: avoid; }
    .c-no { width: 26px; color: #666; }
    .c-hsn { width: 62px; }
    .c-num { text-align: right; white-space: nowrap; }
    th.c-num { text-align: right; }
    .totals, .payments { font-size: 10pt; }
    .totals { margin-bottom: 12px; border: 1px solid #bbb; }
    .totals th, .payments th { padding: 3px 10px; font-weight: 400; color: #444; text-align: left; }
    .totals td, .payments td { padding: 3px 10px; text-align: right; white-space: nowrap; }
    .totals .grand th, .totals .grand td {
      padding: 7px 10px;
      font-size: 12.5pt;
      font-weight: 700;
      color: #111;
      background: #f1f1f1;
      border-top: 1.5px solid #111;
    }
    .payments { margin: -6px 0 12px; }
    .payments th, .payments td { color: #555; font-size: 9.5pt; }
    .tax { margin-bottom: 12px; font-size: 9pt; }
    .tax th, .tax td { padding: 4px 6px; border: 1px solid #bbb; text-align: left; }
    .tax th.c-num, .tax td.c-num { text-align: right; }
    .tax thead th {
      background: #f1f1f1;
      font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .note { margin: 8px 0 0; font-size: 9.5pt; color: #555; }
    /* Boxed, because it is the line that settles an argument about the figures
       above it, and it has to be findable at a glance to do that. */
    .words { margin: 0 0 12px; padding: 6px 10px; border: 1px solid #111; font-size: 10pt; }
    .words .k {
      display: block; margin-bottom: 1px;
      font-size: 8pt; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #555;
    }
    /* Centred on a rule that spans the paper: the shop's closing line, as the
       thermal roll has always set it. */
    .terms {
      margin: 16px 0 0; padding-top: 8px;
      font-size: 9pt; color: #555; text-align: center;
      border-top: 1px solid #ddd;
    }
    .signature { margin-top: 30px; width: 220px; justify-self: end; text-align: center; break-inside: avoid; }
    .sign-for { font-size: 9.5pt; font-weight: 600; color: #333; }
    .sign-rule { margin-top: 42px; border-top: 1px solid #111; }
    .sign-label { margin-top: 3px; font-size: 8.5pt; color: #555; }
  `
}

/** What this kind of document calls its number, its party and its author. */
function wordsFor(doc: ReceiptDoc): DocWording {
  return doc.wording ?? BILL_WORDING
}
