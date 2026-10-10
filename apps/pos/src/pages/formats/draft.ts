import {
  DocFormat as Fmt, type Block, type PaperSize, type StoredFormat, type FormatProblem,
  type ReceiptDoc, type TemplateProblem, businessDate,
} from '@shopos/core'

/*
 * What the format editor works on: the draft it holds, the sample bill its
 * previews print, and the words for what is wrong with a format.
 */

/** A believable bill, so the preview shows the shape rather than empty columns. */
export function sampleDoc(shop: ReceiptDoc['shop']): ReceiptDoc {
  const money = (rupees: number) => Math.round(rupees * 100) as ReceiptDoc['subtotal']
  const qty = (units: number) => Math.round(units * 10_000) as ReceiptDoc['items'][number]['qty']

  return {
    shop,
    docNo: 'INV/MR/26-27/00023',
    postingDate: businessDate(),
    postedAt: new Date().toISOString(),
    cashier: 'admin',
    customerName: 'Sri Vidya School',
    items: [
      { name: 'A4 Copier Paper 500 sheets', qty: qty(2), saleUnit: 'ream', rate: money(340), lineTotal: money(680) },
      { name: 'Ball Pen Blue', qty: qty(12), saleUnit: 'piece', rate: money(10), lineTotal: money(120), mrp: money(12) },
    ],
    subtotal: money(800),
    discount: money(0),
    taxableTotal: money(677.97),
    cgst: money(61.01),
    sgst: money(61.01),
    igst: money(0),
    grandTotal: money(800),
    payments: [{ method: 'cash', amount: money(800), tendered: money(1000) }],
    pointsEarned: 8,
    pointsBalance: 120,
  }
}

export function problemText(problem: FormatProblem, paper: Fmt.PaperSize): string {
  switch (problem.code) {
    case 'NAME_REQUIRED': return 'Give the format a name, so it can be told apart in the list.'
    case 'NOTHING_ON': return 'Every block is switched off, which would print a blank slip.'
    case 'NO_ITEMS_BLOCK':
      return 'Switch the items block on. A receipt with no items on it is a total on a piece of paper.'
    case 'NOT_IMPLEMENTED':
      return `${Fmt.BLOCK_LABEL[problem.kind]} is not ready on this paper. ${Fmt.notYet(problem.kind, paper) ?? ''}`
    case 'TEMPLATE_ON_ROLL':
      return 'A till roll is sent to the printer as plain characters — there is no HTML anywhere '
        + 'in that path, so a page written here could never print on it. Clear the HTML, or put '
        + 'this format back on a sheet.'
    case 'TEMPLATE':
      return templateProblemText(problem.problem)
  }
}

/**
 * What is wrong with the shop's own markup, in the shop's own terms.
 *
 * Every one of these names the thing to fix rather than the rule that was
 * broken. A person who has just pasted their letterhead in wants to know which
 * line to change.
 */
export function templateProblemText(problem: TemplateProblem): string {
  switch (problem.code) {
    case 'EMPTY':
      return 'There is no HTML in the box. Start from the built-in design, or switch back to blocks.'
    case 'UNKNOWN_TOKEN':
      return `There is no {{${problem.name}}}. Check it against the list of tokens below — a `
        + 'misspelt one would print as a blank space on every bill.'
    case 'UNKNOWN_SECTION':
      return `{{#${problem.name}}} is not a section. The two that repeat are {{#items}} and {{#payments}}.`
    case 'UNCLOSED':
      return `{{#${problem.name}}} was opened and never closed. Add {{/${problem.name}}}.`
    case 'UNOPENED':
      return `{{/${problem.name}}} closes something that was never opened.`
    case 'TOKEN_OUT_OF_SECTION':
      return `{{${problem.name}}} belongs to one line, so it only means something between `
        + `{{#${problem.section}}} and {{/${problem.section}}}.`
    case 'SCRIPT':
      return 'This page carries a script, and a bill never runs one. Remove the <script>, the '
        + 'frame, or the javascript: link — it is refused rather than quietly stripped out, '
        + 'because cleaning up markup is a game you only have to lose once.'
    case 'HANDLER':
      return `${problem.name}="…" is a script written a different way. Remove it.`
    case 'OFF_DEVICE':
      return `This page fetches ${problem.url} from the internet. The shop has to be able to `
        + 'print with the line down, so everything on a bill has to already be on this machine. '
        + 'Upload the logo on the Settings screen and use {{shop.logo}} instead.'
  }
}

/**
 * Everything this product can print through a format.
 *
 * A format declares which of them it is for, and that declaration is what the
 * print path looks for — so a sheet ticked for quotations is found when a
 * quotation is printed and not otherwise.
 */
export const PRINTABLE = ['bill', 'quotation', 'sales_order', 'purchase_order'] as const

export const KIND_LABELS: Record<string, string> = {
  bill: 'Bills',
  quotation: 'Quotations',
  sales_order: 'Sales orders',
  purchase_order: 'Purchase orders',
}

export interface Draft {
  id: string | null
  name: string
  paper: PaperSize
  kinds: string[]
  blocks: Block[]
  /** The shop's own HTML for a sheet; null means the blocks lay it out. */
  template: string | null
}

export function draftOf(format: StoredFormat): Draft {
  return {
    id: format.id,
    name: format.name,
    paper: format.paper,
    kinds: format.kinds,
    blocks: format.blocks,
    template: format.template ?? null,
  }
}
