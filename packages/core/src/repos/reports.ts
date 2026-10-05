/*
 * In pieces by what a report is about: `reports/scope.ts` is the date range and
 * the counter filter they all share, `reports/sales.ts` what was sold and how it
 * was paid, `reports/gst.ts` what the returns are filed from, and
 * `reports/margin.ts` what the shop made on it. Re-exported here, which is the
 * namespace every caller reads them through.
 */

/**
 * Every figure here is read from submitted documents (docstatus = 1) and nothing
 * else. Drafts are not sales and cancelled bills are not sales, so a report and
 * the bill list can never tell the shop two different stories.
 */

/** RFC 4180: a field containing a comma, quote or newline is quoted, quotes doubled. */
/* Moved to `domain/csv.ts`, beside the reader, and re-exported here so that
   every `Reports.toCsv` caller is unchanged. The two halves have to agree
   about quoting and line endings, and the way to be sure of that is to keep
   them in one file with the tests that round-trip them. */
export { toCsv } from '../domain/csv.js'

export type { DateRange } from './reports/scope.js'
export { daySales, paymentMix, salesByDay, salesByStaff, salesSummary, topProducts } from './reports/sales.js'
export type { DayRow, ProductRow, SalesSummary, StaffRow, TenderRow } from './reports/sales.js'
export { gstExceptions, gstLines, taxByRate } from './reports/gst.js'
export type { GstException, GstLine, TaxRateRow } from './reports/gst.js'
export { gstr1 } from './reports/gstr1.js'
export { purchaseRegister } from './reports/purchases.js'
export type { PurchaseRegister, PurchaseRegisterRow } from './reports/purchases.js'
export { buildGstr1, gstr1Files, b2clThreshold, uqcFor } from '../domain/gstr1.js'
export type { Gstr1 } from '../domain/gstr1.js'
export { grossMargin, marginByProduct } from './reports/margin.js'
export type { Margin, ProductMargin } from './reports/margin.js'
