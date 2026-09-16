/**
 * The HSN code on a product, and whether it is the shape of one.
 *
 * HSN is the goods classification a GST return is summarised by. A code is 4,
 * 6 or 8 digits — those are the levels the schedule is published at, and a
 * five- or seven-digit number is not a truncation of anything, it is a typo.
 *
 * ── Warned, never blocked ─────────────────────────────────────────────────
 *
 * A shopkeeper entering three hundred items from a supplier's list is the
 * person most likely to mistype one and least able to stop and find the right
 * answer. Refusing the save would mean the item cannot be sold at all, which is
 * a worse outcome than an invoice carrying a code that is slightly wrong — the
 * shop is trading either way, and one of the two states can be fixed on a quiet
 * afternoon.
 *
 * The same reasoning as `isGstin`: the shape is checked and the *meaning* is
 * not. Whether 4820 is the right chapter for a notebook is a question for the
 * schedule, and software that guessed at it would be confidently wrong on the
 * items a stationery shop actually sells.
 */

/** Four, six or eight digits. Nothing else is a level of the schedule. */
export const HSN_SHAPE = /^(\d{4}|\d{6}|\d{8})$/

export function isHsn(code: string | null | undefined): boolean {
  return typeof code === 'string' && HSN_SHAPE.test(code)
}

export type HsnProblem = 'HSN_SHAPE'

/**
 * What is wrong with a code, or nothing.
 *
 * An absent code is not a problem here. Plenty of shops have never been asked
 * for one and a blank field is honest; the GST export is where their absence
 * becomes worth saying, and only on the B2B lines where a registered buyer
 * needs it.
 */
export function hsnProblem(code: string | null | undefined): HsnProblem | null {
  const trimmed = (code ?? '').trim()
  if (trimmed === '') return null
  return isHsn(trimmed) ? null : 'HSN_SHAPE'
}

/** What to tell somebody typing it, in the words the form should use. */
export const HSN_SHAPE_MESSAGE =
  'An HSN code is 4, 6 or 8 digits. This will be saved and will print as it is, '
  + 'but it will not match anything on a GST return.'
