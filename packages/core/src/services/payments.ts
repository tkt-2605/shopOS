/*
 * Money a customer hands over, and what it settles.
 *
 * In pieces by job: `payments/receipts.ts` takes a payment and undoes one,
 * `payments/outstanding.ts` says what is owed, `payments/advance.ts` is money
 * held for a customer before anything is billed, `payments/khata.ts` is the rest
 * of the book -- the list of receipts, write-offs, and the balance carried over
 * from before -- and `payments/account.ts` puts all of it on one statement.
 * Re-exported here, where every caller has always found them.
 */

export { cancelPayment, postCreditNote, recordPayment } from './payments/receipts.js'
export type { ReceiptMethod, RecordPaymentInput, RecordPaymentResult } from './payments/receipts.js'
export {
  customerOutstanding, customerStatement, loadOpenBills, totalOutstandingAll,
} from './payments/outstanding.js'
export type { CustomerStatementRow, OutstandingTotal } from './payments/outstanding.js'
export { advanceCredit, applyAdvance, refundAdvance } from './payments/advance.js'
export type {
  AdvanceCredit, AdvanceReceipt, ApplyAdvanceResult, RefundAdvanceInput, RefundAdvanceResult,
} from './payments/advance.js'
export { listCustomerPayments, recordOpeningBalance, writeOff } from './payments/khata.js'
export type { CustomerPayment, OpeningBalanceResult } from './payments/khata.js'
export { customerAccount } from './payments/account.js'
export type { CustomerAccount, StatementEntry, StatementKind } from './payments/account.js'
