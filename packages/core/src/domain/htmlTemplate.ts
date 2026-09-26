import { format as fmtMoney, inWords, type Money } from '../money.js'
import { formatQty } from '../quantity.js'
import { formatDate, escapeHtml as esc } from './docText.js'
import { BILL_WORDING, type DocWording } from './wording.js'
/* Type-only, and it has to stay that way: a runtime import of `receipt.ts` from
   here would close the ring back through `docFormat.ts`. See `wording.ts`. */
import type { ReceiptDoc } from './receipt/doc.js'

/**
 * The shop's own HTML, for the sheet only.
 *
 * The blocks in `docFormat.ts` were chosen over a template language on purpose,
 * and the reasoning there still stands *for the roll*: a mistyped brace printing
 * rubbish at a counter mid-queue, with a customer waiting, is not a trade worth
 * offering, and a thermal receipt is a column of characters where there is very
 * little a shop could want that a block cannot give.
 *
 * A sheet is a different argument, and the reasons the blocks won do not carry:
 *
 *   - It is already HTML. The renderer is `invoiceHtml.ts` and the output is a
 *     page; there is no new format to invent, only a way in.
 *   - Nobody is waiting. A sheet goes through a print dialog, from a screen with
 *     a live preview beside it, and is usually a copy a business will file.
 *   - The demands are real and endless. A letterhead the shop already prints, a
 *     column their buyer's accounts department asks for, a bilingual heading, a
 *     terms block three paragraphs long. Blocks answer these one feature request
 *     at a time and never catch up.
 *
 * So the trade is made differently here, and paid for in three ways:
 *
 *   1. **Nothing executes.** A template carrying a script, an event handler, or
 *      a `javascript:` URL is refused outright rather than stripped. This page
 *      is handed to a print window inside the app, and sanitising is a game you
 *      only have to lose once.
 *   2. **Nothing is fetched.** An external stylesheet or image is refused too.
 *      The product is offline-first: a bill that prints correctly in the shop
 *      and blank at four in the morning when the line is down is worse than one
 *      that was never allowed.
 *   3. **A typo is caught before it prints, not after.** Every token is checked
 *      against the list below, every section against its closing tag. The shop
 *      is told `{{shop.nmae}}` is not a thing, on the screen, with the preview
 *      beside it — rather than a customer being handed a bill with a hole in it.
 *
 * Pure, like every other file in this folder: a string and a document in, a
 * string out. No DOM, no printer, no database.
 */

/* ------------------------------------------------------------- tokens --- */

/**
 * Every name a template may use, and what it means.
 *
 * This is the catalogue the designer screen lists *and* the list the checker
 * validates against, deliberately the same one — a token documented but not
 * resolved, or resolved but not documented, is the fault this whole product
 * keeps finding in itself.
 */
export interface TokenDoc {
  token: string
  means: string
  /** Only inside the section named here. */
  section?: SectionKind
}

export type SectionKind = 'items' | 'payments'

export const TEMPLATE_TOKENS: readonly TokenDoc[] = [
  { token: 'shop.name', means: 'The shop’s name' },
  { token: 'shop.address', means: 'The shop’s address' },
  { token: 'shop.phone', means: 'The shop’s phone number' },
  { token: 'shop.email', means: 'The shop’s email address' },
  { token: 'shop.gstin', means: 'The shop’s GSTIN' },
  { token: 'shop.logo', means: 'The uploaded logo, for an img src — wrap it in {{#if shop.logo}}' },

  { token: 'doc.title', means: 'What the document calls itself — Tax Invoice, Quotation' },
  { token: 'doc.no', means: 'The document number' },
  { token: 'doc.date', means: 'The date on it' },
  { token: 'doc.valid_until', means: 'The date a quoted price stops being a promise' },
  { token: 'doc.place_of_supply', means: 'The place of supply, for GST' },
  { token: 'doc.cashier', means: 'Who raised it' },
  { token: 'doc.notes', means: 'The note typed on the document' },
  { token: 'doc.terms', means: 'The terms set on the Settings screen' },
  { token: 'doc.footer', means: 'The one-line footer set on the Settings screen' },

  { token: 'customer.name', means: 'The customer, when the document names one' },
  { token: 'customer.address', means: 'Their address' },
  { token: 'customer.gstin', means: 'Their GSTIN' },

  { token: 'total.subtotal', means: 'Before discount and tax' },
  { token: 'total.discount', means: 'The discount given' },
  { token: 'total.taxable', means: 'The taxable value' },
  { token: 'total.cgst', means: 'CGST' },
  { token: 'total.sgst', means: 'SGST' },
  { token: 'total.igst', means: 'IGST' },
  { token: 'total.tax', means: 'CGST, SGST and IGST added up' },
  { token: 'total.round_off', means: 'The paise added or dropped, signed' },
  { token: 'total.grand', means: 'The amount due' },
  { token: 'total.in_words', means: 'The amount due, spelled out' },
  { token: 'total.count', means: 'How many lines there are' },

  { token: 'item.no', means: 'The line number, from 1', section: 'items' },
  { token: 'item.name', means: 'The item’s name', section: 'items' },
  { token: 'item.hsn', means: 'Its HSN code', section: 'items' },
  { token: 'item.qty', means: 'How many', section: 'items' },
  { token: 'item.unit', means: 'The unit sold in', section: 'items' },
  { token: 'item.rate', means: 'The rate charged', section: 'items' },
  { token: 'item.mrp', means: 'The printed price, when the item carries one', section: 'items' },
  { token: 'item.taxable', means: 'The line’s taxable value', section: 'items' },
  { token: 'item.tax', means: 'The tax on the line', section: 'items' },
  { token: 'item.amount', means: 'What the line comes to', section: 'items' },

  { token: 'payment.method', means: 'Cash, card, UPI…', section: 'payments' },
  { token: 'payment.amount', means: 'How much came in that way', section: 'payments' },
]

const KNOWN = new Set(TEMPLATE_TOKENS.map((t) => t.token))
const SECTION_OF = new Map(TEMPLATE_TOKENS.map((t) => [t.token, t.section]))

/* -------------------------------------------------------------- parse --- */

type Node =
  | { t: 'text'; text: string }
  | { t: 'token'; name: string }
  | { t: 'loop'; kind: SectionKind; body: Node[] }
  /** Rendered only when the token has something in it. */
  | { t: 'if'; name: string; not: boolean; body: Node[] }

const TAG = /\{\{\s*([#^/]?)\s*([a-z0-9_.]+)(?:\s+([a-z0-9_.]+))?\s*\}\}/gi

export type TemplateProblem =
  | { code: 'UNKNOWN_TOKEN'; name: string }
  | { code: 'UNKNOWN_SECTION'; name: string }
  | { code: 'UNCLOSED'; name: string }
  | { code: 'UNOPENED'; name: string }
  /** `{{item.name}}` outside `{{#items}}`, where there is no item to ask. */
  | { code: 'TOKEN_OUT_OF_SECTION'; name: string; section: SectionKind }
  | { code: 'SCRIPT' }
  | { code: 'HANDLER'; name: string }
  | { code: 'OFF_DEVICE'; url: string }
  | { code: 'EMPTY' }

interface Parsed {
  nodes: Node[]
  problems: TemplateProblem[]
}

/**
 * Reads a template into nodes, collecting every fault rather than stopping at
 * the first. A shop that pasted a letterhead wants the whole list of what is
 * wrong with it, not one line at a time across six saves.
 */
function parse(source: string): Parsed {
  const problems: TemplateProblem[] = []
  const root: Node[] = []
  const stack: { name: string; nodes: Node[]; close: (body: Node[]) => Node }[] = []
  const here = () => (stack.length === 0 ? root : stack[stack.length - 1]!.nodes)

  let at = 0
  TAG.lastIndex = 0
  for (let m = TAG.exec(source); m; m = TAG.exec(source)) {
    const [whole, sigil, name, argument] = m as unknown as [string, string, string, string | undefined]
    if (m.index > at) here().push({ t: 'text', text: source.slice(at, m.index) })
    at = m.index + whole.length

    if (sigil === '#' || sigil === '^') {
      if (name === 'if') {
        const token = argument ?? ''
        if (!KNOWN.has(token)) problems.push({ code: 'UNKNOWN_TOKEN', name: token })
        const not = sigil === '^'
        stack.push({
          name: 'if',
          nodes: [],
          close: (body) => ({ t: 'if', name: token, not, body }),
        })
        continue
      }
      if (name === 'items' || name === 'payments') {
        stack.push({ name, nodes: [], close: (body) => ({ t: 'loop', kind: name, body }) })
        continue
      }
      problems.push({ code: 'UNKNOWN_SECTION', name })
      continue
    }

    if (sigil === '/') {
      const open = stack.pop()
      if (!open) { problems.push({ code: 'UNOPENED', name }); continue }
      if (open.name !== name) {
        problems.push({ code: 'UNCLOSED', name: open.name })
        // Closed anyway, so one stray tag does not cascade into ten complaints.
      }
      here().push(open.close(open.nodes))
      continue
    }

    if (!KNOWN.has(name)) { problems.push({ code: 'UNKNOWN_TOKEN', name }); continue }

    /* A token that only exists per line, used where there is no line. It would
       render as nothing, which is exactly the silent hole this refuses. */
    const needs = SECTION_OF.get(name)
    if (needs && !stack.some((s) => s.name === needs)) {
      problems.push({ code: 'TOKEN_OUT_OF_SECTION', name, section: needs })
      continue
    }

    here().push({ t: 'token', name })
  }

  if (at < source.length) here().push({ t: 'text', text: source.slice(at) })

  while (stack.length > 0) {
    const open = stack.pop()!
    problems.push({ code: 'UNCLOSED', name: open.name })
    here().push(open.close(open.nodes))
  }

  return { nodes: root, problems }
}

/* ------------------------------------------------------------- safety --- */

/**
 * What a printed page is never allowed to do.
 *
 * Refused rather than stripped, and refused on the source text rather than on a
 * parsed tree, because the question is not "is this markup safe once we have
 * understood it" — it is "did the shop paste something that has no business on
 * a bill". A template with a tracking pixel in it is a template the shop should
 * be told about, not one quietly cleaned up behind them.
 */
const SCRIPT = /<\s*script\b|<\s*iframe\b|<\s*object\b|<\s*embed\b/i
const HANDLER = /\son([a-z]+)\s*=/i
const OFF_DEVICE = /(?:src|href)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'>\s]+)/i
const IMPORT = /@import\s+(?:url\()?["']?\s*((?:https?:)?\/\/[^"')\s]+)/i
const JS_URL = /(?:src|href|action)\s*=\s*["']?\s*javascript:/i

function unsafe(source: string): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  if (SCRIPT.test(source) || JS_URL.test(source)) problems.push({ code: 'SCRIPT' })

  const handler = HANDLER.exec(source)
  if (handler) problems.push({ code: 'HANDLER', name: `on${handler[1]}` })

  const remote = OFF_DEVICE.exec(source) ?? IMPORT.exec(source)
  if (remote) problems.push({ code: 'OFF_DEVICE', url: remote[1]! })

  return problems
}

/** Everything wrong with a template — empty when it is fit to print. */
export function checkTemplate(source: string): TemplateProblem[] {
  if (source.trim() === '') return [{ code: 'EMPTY' }]
  return [...unsafe(source), ...parse(source).problems]
}

/* ------------------------------------------------------------- render --- */

/** A flat record of what a document has to say. */
export type Facts = Record<string, string>

export interface TemplateData {
  facts: Facts
  items: Facts[]
  payments: Facts[]
}

function renderNodes(nodes: Node[], facts: Facts): string {
  let out = ''
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        out += node.text
        break
      case 'token':
        out += esc(facts[node.name] ?? '')
        break
      case 'if': {
        const has = (facts[node.name] ?? '') !== ''
        if (has !== node.not) out += renderNodes(node.body, facts)
        break
      }
      case 'loop': {
        const rows = node.kind === 'items' ? facts['@items'] : facts['@payments']
        // Carried on the facts record as JSON so the node walk stays one
        // parameter wide; the lists are small and this runs once per print.
        const list: Facts[] = rows ? (JSON.parse(rows) as Facts[]) : []
        for (const row of list) out += renderNodes(node.body, { ...facts, ...row })
        break
      }
    }
  }
  return out
}

/**
 * The shop's template, filled in.
 *
 * Refuses rather than half-renders: a template with a fault in it produces
 * nothing here and the caller falls back to the design the product ships with,
 * so the worst case is a bill that looks like the standard one rather than a
 * bill with a hole in it. The screen is where a shop finds out — `checkTemplate`
 * is what it calls, with the preview beside it.
 */
export function renderTemplate(source: string, data: TemplateData): string | null {
  if (checkTemplate(source).length > 0) return null

  const facts: Facts = {
    ...data.facts,
    '@items': JSON.stringify(data.items),
    '@payments': JSON.stringify(data.payments),
  }
  return renderNodes(parse(source).nodes, facts)
}

/* -------------------------------------------------------------- facts --- */

/** What a document has to say, as the tokens above name it. */
export function templateData(doc: ReceiptDoc): TemplateData {
  const words: DocWording = doc.wording ?? BILL_WORDING
  const tax = (doc.cgst + doc.sgst + doc.igst) as Money

  return {
    facts: {
      'shop.name': doc.shop.name,
      'shop.address': doc.shop.address ?? '',
      'shop.phone': doc.shop.phone ?? '',
      'shop.email': doc.shop.email ?? '',
      'shop.gstin': doc.shop.gstin ?? '',
      /* Only a data URI, and only one that cannot close an attribute — the same
         guard `invoiceHtml.ts` puts on the logo block. Anything else renders as
         empty, so `{{#if shop.logo}}` correctly says there is no logo. */
      'shop.logo': doc.shop.logo && SAFE_DATA_URI.test(doc.shop.logo) ? doc.shop.logo : '',

      'doc.title': words.title,
      'doc.no': doc.docNo,
      'doc.date': formatDate(doc.postingDate),
      'doc.valid_until': doc.validUntil ? formatDate(doc.validUntil) : '',
      /* Both halves, because a template author writing {{doc.place_of_supply}}
         wants what an invoice prints there -- "27 — Maharashtra" -- and not a
         number they would then have to look up. */
      'doc.place_of_supply': doc.placeOfSupply
        ? `${doc.placeOfSupply.code} — ${doc.placeOfSupply.name}`
        : '',
      'doc.cashier': doc.cashier ?? '',
      'doc.notes': doc.notes ?? '',
      'doc.terms': doc.terms ?? '',
      'doc.footer': doc.footer ?? '',

      'customer.name': doc.customerName ?? '',
      'customer.address': doc.customerAddress ?? '',
      'customer.gstin': doc.customerGstin ?? '',

      'total.subtotal': fmtMoney(doc.subtotal),
      'total.discount': doc.discount > 0 ? fmtMoney(doc.discount) : '',
      'total.taxable': fmtMoney(doc.taxableTotal),
      'total.cgst': doc.cgst > 0 ? fmtMoney(doc.cgst) : '',
      'total.sgst': doc.sgst > 0 ? fmtMoney(doc.sgst) : '',
      'total.igst': doc.igst > 0 ? fmtMoney(doc.igst) : '',
      'total.tax': tax > 0 ? fmtMoney(tax) : '',
      /* Blank rather than "0.00" when nothing was rounded, so `{{#if}}` can drop
         the whole row — a "Round off 0.00" line answers a question nobody asked. */
      'total.round_off': doc.roundOff ? signedMoney(doc.roundOff) : '',
      'total.grand': fmtMoney(doc.grandTotal),
      'total.in_words': inWords(doc.grandTotal),
      'total.count': String(doc.items.length),
    },

    items: doc.items.map((item, i) => ({
      'item.no': String(i + 1),
      'item.name': item.name,
      'item.hsn': item.hsnCode ?? '',
      'item.qty': formatQty(item.qty),
      'item.unit': item.saleUnit,
      'item.rate': fmtMoney(item.rate),
      'item.mrp': item.mrp ? fmtMoney(item.mrp) : '',
      'item.taxable': item.taxableValue === undefined ? '' : fmtMoney(item.taxableValue),
      'item.tax': fmtMoney(((item.cgst ?? 0) + (item.sgst ?? 0) + (item.igst ?? 0)) as Money),
      'item.amount': fmtMoney(item.lineTotal),
    })),

    payments: doc.payments.map((p) => ({
      'payment.method': p.method.charAt(0).toUpperCase() + p.method.slice(1),
      'payment.amount': fmtMoney(p.amount),
    })),
  }
}

const SAFE_DATA_URI = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/

function signedMoney(amount: Money): string {
  return amount < 0 ? `-${fmtMoney(Math.abs(amount) as Money)}` : `+${fmtMoney(amount)}`
}

/* ------------------------------------------------------------- starter --- */

/**
 * Something to start from.
 *
 * Nobody writes an invoice into an empty box. This is roughly what the blocks
 * produce — the shop on the left, the invoice details on the right, an item
 * table, totals, terms and a signature — written out as the markup a shop can
 * then move around, so the first edit is a change rather than a beginning.
 *
 * It is a demonstration as much as a starting point: every section form is in
 * it once (`{{#items}}`, `{{#if}}`, `{{^if}}`), so the shapes can be copied
 * rather than looked up.
 */
export const STARTER_TEMPLATE = `<style>
  /* Yours to change. The page box, its margins and the fonts are already set. */
  .head    { display: flex; justify-content: space-between; align-items: flex-start; }
  .name    { font-size: 17pt; font-weight: 700; }
  .muted   { font-size: 9.5pt; color: #444; }
  .who     { text-align: right; font-size: 10pt; }
  .who b   { display: inline-block; min-width: 96px; text-align: left; color: #555; font-weight: 400; }
  .title   { margin: 14px 0 10px; padding: 6px 0; text-align: center; font-size: 12pt;
             font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
             border-top: 1px solid #111; border-bottom: 1px solid #111; }
  .party   { margin-bottom: 12px; padding: 8px 10px; border: 1px solid #bbb; }
  .items   { width: 100%; font-size: 10pt; border-collapse: collapse; }
  .items th{ padding: 5px 6px; text-align: left; font-size: 8.5pt; text-transform: uppercase;
             border-bottom: 1.5px solid #111; }
  .items td{ padding: 5px 6px; border-bottom: 1px solid #ddd; }
  .items tr{ break-inside: avoid; }
  .r       { text-align: right; white-space: nowrap; }
  .sums    { width: 46%; margin: 12px 0 0 auto; font-size: 10pt; border-collapse: collapse; }
  .sums th { padding: 2px 6px; text-align: left; font-weight: 400; color: #444; }
  .sums td { padding: 2px 6px; text-align: right; }
  .sums .grand th, .sums .grand td { padding-top: 5px; font-size: 12pt; font-weight: 700;
                                     border-top: 1.5px solid #111; }
  .words   { margin-top: 10px; padding: 6px 8px; border: 1px solid #000; font-size: 10pt; }
  .terms   { margin-top: 16px; padding-top: 8px; font-size: 9pt; color: #555;
             border-top: 1px solid #ddd; }
  .sign    { margin: 34px 0 0 auto; width: 210px; text-align: center; break-inside: avoid; }
  .rule    { margin-top: 40px; border-top: 1px solid #111; }
</style>

<div class="head">
  <div>
    {{#if shop.logo}}<img src="{{shop.logo}}" style="height:18mm" alt="">{{/if}}
    <div class="name">{{shop.name}}</div>
    <div class="muted">{{shop.address}}</div>
    {{#if shop.phone}}<div class="muted">Phone {{shop.phone}}</div>{{/if}}
    {{#if shop.gstin}}<div class="muted">GSTIN {{shop.gstin}}</div>{{/if}}
  </div>
  <div class="who">
    <div><b>Number</b> {{doc.no}}</div>
    <div><b>Date</b> {{doc.date}}</div>
    {{#if doc.place_of_supply}}<div><b>Place of supply</b> {{doc.place_of_supply}}</div>{{/if}}
  </div>
</div>

<div class="title">{{doc.title}}</div>

{{#if customer.name}}
<div class="party">
  <div class="muted">Billed to</div>
  <div style="font-size:11.5pt;font-weight:700">{{customer.name}}</div>
  {{#if customer.address}}<div class="muted">{{customer.address}}</div>{{/if}}
  {{#if customer.gstin}}<div class="muted">GSTIN {{customer.gstin}}</div>{{/if}}
</div>
{{/if}}

<table class="items">
  <thead>
    <tr>
      <th style="width:26px">#</th>
      <th>Item</th>
      <th class="r">Qty</th>
      <th class="r">Rate</th>
      <th class="r">Amount</th>
    </tr>
  </thead>
  <tbody>
    {{#items}}
    <tr>
      <td>{{item.no}}</td>
      <td>{{item.name}}{{#if item.hsn}} <span class="muted">HSN {{item.hsn}}</span>{{/if}}</td>
      <td class="r">{{item.qty}} {{item.unit}}</td>
      <td class="r">{{item.rate}}</td>
      <td class="r">{{item.amount}}</td>
    </tr>
    {{/items}}
  </tbody>
</table>

<table class="sums">
  <tbody>
    <tr><th>Subtotal</th><td>{{total.subtotal}}</td></tr>
    {{#if total.discount}}<tr><th>Discount</th><td>-{{total.discount}}</td></tr>{{/if}}
    <tr><th>Taxable value</th><td>{{total.taxable}}</td></tr>
    {{#if total.cgst}}<tr><th>CGST</th><td>{{total.cgst}}</td></tr>{{/if}}
    {{#if total.sgst}}<tr><th>SGST</th><td>{{total.sgst}}</td></tr>{{/if}}
    {{#if total.igst}}<tr><th>IGST</th><td>{{total.igst}}</td></tr>{{/if}}
    {{#if total.round_off}}<tr><th>Round off</th><td>{{total.round_off}}</td></tr>{{/if}}
    <tr class="grand"><th>Total</th><td>{{total.grand}}</td></tr>
    {{#payments}}
    <tr><th>{{payment.method}}</th><td>{{payment.amount}}</td></tr>
    {{/payments}}
  </tbody>
</table>

<div class="words"><span class="muted">Amount in words</span><br>{{total.in_words}}</div>

{{#if doc.terms}}<div class="terms">{{doc.terms}}</div>{{/if}}
{{^if doc.terms}}{{#if doc.footer}}<div class="terms">{{doc.footer}}</div>{{/if}}{{/if}}

<div class="sign">
  <div class="muted">For {{shop.name}}</div>
  <div class="rule"></div>
  <div class="muted" style="font-size:8.5pt">Authorised signatory</div>
</div>
`
