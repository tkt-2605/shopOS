import { BILL_WORDING, type DocWording } from './wording.js'

/**
 * Which GST scheme the shop is under, and what that changes on the paper.
 *
 * This product has charged GST on every line of every bill since v1, with no
 * way to say that the shop does not collect it. Two kinds of shop it is sold to
 * do not:
 *
 *   **Composition** — turnover under the threshold, a flat percentage paid out
 *   of the shop's own pocket rather than collected from the customer. Section 10
 *   forbids collecting tax on supplies, and Rule 49 says the document is a *Bill
 *   of Supply* carrying a statement saying so in as many words.
 *
 *   **Unregistered** — below the registration threshold, or simply not
 *   registered yet. No GSTIN, no tax, and no tax invoice: a plain invoice.
 *
 * A shop in either of them running this product has been handing customers a
 * document headed "Tax Invoice" showing CGST and SGST it is not entitled to
 * collect. That is not a cosmetic problem. Collecting tax without being
 * entitled to is its own offence, and the customer has been claiming input
 * credit on it.
 *
 * ── What changes, and what deliberately does not ──────────────────────────
 *
 * Under the two non-regular schemes the till charges nothing: the taxable value
 * of a line is the line total and the tax is zero. **The product's own tax rate
 * is left alone.** A shop that registers next year should not have to re-enter
 * the rate on nine hundred products, and the rate is a fact about the goods
 * rather than about the shop.
 *
 * Nothing about this is retrospective. Bills already raised charged what they
 * charged and say what they say.
 */

export type TaxScheme = 'regular' | 'composition' | 'unregistered'

export const TAX_SCHEMES: readonly TaxScheme[] = ['regular', 'composition', 'unregistered']

export function isTaxScheme(value: string | null | undefined): value is TaxScheme {
  return typeof value === 'string' && (TAX_SCHEMES as readonly string[]).includes(value)
}

/** Whether the till adds tax to a line at all. */
export function chargesTax(scheme: TaxScheme): boolean {
  return scheme === 'regular'
}

/**
 * What the document calls itself.
 *
 * Rule 49 for composition, and a plain "Invoice" for an unregistered shop —
 * which is a real document and an honest one, and is the word a shop that
 * charges no tax should have on its paper.
 */
export function documentTitle(scheme: TaxScheme): string {
  switch (scheme) {
    case 'regular': return 'Tax Invoice'
    case 'composition': return 'Bill of Supply'
    case 'unregistered': return 'Invoice'
  }
}

/**
 * The sentence Rule 49 requires on a composition dealer's bill of supply, in
 * the words the rule uses. Not paraphrased: the wording is the requirement.
 */
export const COMPOSITION_STATEMENT =
  'Composition taxable person, not eligible to collect tax on supplies'

export function schemeStatement(scheme: TaxScheme): string | null {
  return scheme === 'composition' ? COMPOSITION_STATEMENT : null
}

/**
 * What a GSTIN on its own says about a shop that has never been asked.
 *
 * A GSTIN is a registration, so a shop that has entered one is charging tax on
 * purpose and stays exactly as it was. Nothing else can be read off this field:
 * an empty one is as likely to mean "there was no screen that could save it"
 * as "not registered", and `loadTaxScheme` is where the rest of the evidence is
 * weighed. This function answers only the half it can.
 *
 * It is a *derivation*, not a stored default, and it keeps deriving until
 * somebody answers. The phase spec asks for a migration that writes a default
 * in once; deriving is the same answer and a better one, because a shop that
 * enters its GSTIN a week later stops being guessed about without anybody
 * having to remember this setting exists.
 */
export function defaultScheme(gstin: string | null | undefined): TaxScheme {
  return gstin && gstin.trim() !== '' ? 'regular' : 'unregistered'
}

/**
 * What a bill calls itself and its parties under a given scheme.
 *
 * The title is the only thing that moves. "Invoice no." and "Billed to" are
 * right on all three documents, and a bill of supply is still billed to
 * somebody.
 */
export function billWording(scheme: TaxScheme): DocWording {
  return { ...BILL_WORDING, title: documentTitle(scheme) }
}
