/*
 * In pieces by stage: `returns/types.ts` is what callers pass and get back,
 * `returns/compute.ts` works out what each line gives back, `returns/submit.ts`
 * raises and posts a return, `returns/cancel.ts` undoes one, `returns/refund.ts`
 * holds the money and points a return moves, and `returns/read.ts` the lists
 * and the detail a screen shows. Re-exported here, where callers find them.
 */

/**
 * A return, and everything it has to undo.
 *
 * The whole decision, written once so the screen and the service cannot disagree
 * about it:
 *
 *   **The refund is what was paid, not what was listed.** `bill_items.line_total`
 *   is already net of the line's own discount and of its share of the bill-level
 *   one, so a half-price item comes back at half price. Refunding the list price
 *   on a discounted bill loses the discount a second time.
 *
 *   **The discount is not re-spread.** Returning one line of a discounted bill
 *   leaves the other lines' shares alone. Re-spreading would change the price of
 *   goods the customer is keeping, on an invoice already printed and filed.
 *
 *   **The last return on a line pays out the remainder** rather than a fresh
 *   percentage, so successive partial returns sum back to the line exactly.
 *
 *   **The refund comes back in the currencies it was paid in** — see
 *   `domain/returns.ts`. Points that paid for goods come back as points.
 *
 *   **Points the sale earned come off**, in proportion, but never below what the
 *   customer has already spent elsewhere. Those are gone, and a negative balance
 *   is worse than the shop absorbing the difference.
 *
 *   **An item marked no-return is refused** before anything is written, and an
 *   item marked no-loyalty earned nothing to take back in the first place.
 *
 *   **The money comes out of today's drawer**, not the one that was open when the
 *   bill was rung up — that session has been counted and closed.
 */

export type {
  CreateReturnInput, CreateReturnResult, ProcessReturnResult, RefundMethod, ReturnLineInput,
  ReturnOutcome, SubmitReturnResult,
} from './returns/types.js'
export { previewReturn } from './returns/compute.js'
export type { PreviewReturnResult, ReturnPreview } from './returns/compute.js'
export { createReturn } from './returns/create.js'
export { submitReturn } from './returns/submit.js'
export { processReturn } from './returns/process.js'
export { cancelReturn } from './returns/cancel.js'
export { ZERO_REFUND } from './returns/refund.js'
export { listReturns, loadReturnDetail, returnableQty } from './returns/read.js'
export type { ReturnDetail, ReturnDetailItem, ReturnListItem } from './returns/read.js'
