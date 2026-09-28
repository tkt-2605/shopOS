/*
 * A bill, from the first line on the counter to its cancellation.
 *
 * In pieces by stage: `billing/types.ts` is what callers pass and get back,
 * `billing/price.ts` prices the lines, `billing/draft.ts` writes a draft,
 * `billing/submit.ts` takes the money and moves the stock, `billing/cancel.ts`
 * undoes and amends, and `billing/load.ts` reads what those stages need.
 * Re-exported here, where every caller has always found them.
 */

export { RULE_46F_THRESHOLD } from './billing/types.js'
export type {
  BillLineInput, BillTotals, CancelBillResult, CreateBillInput, CreateBillResult, PaymentInput,
  PaymentMethod, SubmitBillInput, SubmitBillResult,
} from './billing/types.js'
export { createBill, saveDraft } from './billing/draft.js'
export type { SaveDraftResult } from './billing/draft.js'
export { submitBill } from './billing/submit.js'
export { amendBill, cancelBill } from './billing/cancel.js'
export { billSummary, loadLoyaltyProgram, monthToDateSpend } from './billing/load.js'
