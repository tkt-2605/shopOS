/*
 * @shopos/core/books -- The books and the returns filed from them: the ledger, closing a period, GST and the reports.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export * as Tax from '../domain/tax.js'
export {
  closeBooks, booksClosedThrough, closedFor, periodClosedMessage, BOOKS_CLOSED_THROUGH,
} from '../services/books.js'
export type { PeriodClosed, CloseBooksResult } from '../services/books.js'
export {
  TAX_SCHEMES, isTaxScheme, chargesTax, documentTitle, schemeStatement, defaultScheme,
  billWording, COMPOSITION_STATEMENT,
} from '../domain/taxScheme.js'
export type { TaxScheme } from '../domain/taxScheme.js'
export { listAuditEntries, auditEntities, auditActors, countAuditEntries } from '../repos/audit.js'
export type { AuditEntry, AuditFilter, FieldChange } from '../repos/audit.js'
export * as Reports from '../repos/reports.js'
export type { DateRange } from '../repos/reports.js'
/* The general ledger (064): the chart, posting, and the statements. */
export * as Ledger from '../domain/ledger.js'
export { postVoucherGl, reverseVoucherGl, postMissingGl, fillLedgerOnce } from '../services/ledger.js'
export type { VoucherType, MissingGlOutcome } from '../services/ledger.js'
export { trialBalance, profitAndLoss, balanceSheet, ledgerChecks, partyBalance, generalLedger, VOUCHER_LABEL } from '../repos/ledger.js'
export type { GeneralLedger, LedgerRow, LedgerFilter } from '../repos/ledger.js'
export type {
  AccountBalance, TrialBalance, ProfitAndLoss, BalanceSheet, LedgerChecks,
} from '../repos/ledger.js'
