/*
 * @shopos/core/sales -- The counter: bills, returns, the khata, loyalty, quotations and orders, and what gets printed.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export * as Loyalty from '../domain/loyalty.js'
export * as Credit from '../domain/credit.js'
export * as Returns from '../domain/returns.js'
export * as DocFormat from '../domain/docFormat.js'
export * as HtmlTemplate from '../domain/htmlTemplate.js'
export type { TemplateProblem } from '../domain/htmlTemplate.js'
export type { Block, BlockKind, DocFormat as DocFormatDef, PaperSize, FormatProblem } from '../domain/docFormat.js'
export {
  createBill, submitBill, cancelBill, amendBill, loadBillLoyalty, loadLoyaltyProgram, monthToDateSpend, billSummary,
  RULE_46F_THRESHOLD,
} from '../services/billing.js'
export type {
  BillLineInput, CreateBillInput, CreateBillResult,
  PaymentInput, PaymentMethod, SubmitBillInput, SubmitBillResult,
  CancelBillResult, BillTotals,
} from '../services/billing.js'
export { reconcileLoyalty } from '../services/loyaltyLedger.js'
export type { LoyaltyDrift } from '../services/loyaltyLedger.js'
export { reconcileReturnedQty } from '../services/returns/reconcile.js'
export { reconcileFulfilledQty } from '../services/documents/reconcile.js'
export type { FulfilledDrift } from '../services/documents/reconcile.js'
export type { ReturnedQtyDrift } from '../services/returns/reconcile.js'
export { customerProfit, customerItems } from '../repos/customerHistory.js'
export type { CustomerProfit, CustomerItem } from '../repos/customerHistory.js'
export {
  createReturn, submitReturn, cancelReturn, processReturn, previewReturn, listReturns,
  loadReturnDetail, returnableQty,
} from '../services/returns.js'
export type {
  ReturnLineInput, CreateReturnInput, CreateReturnResult, SubmitReturnResult, RefundMethod,
  ProcessReturnResult, PreviewReturnResult, ReturnPreview, ReturnListItem, ReturnOutcome,
  ReturnDetail, ReturnDetailItem,
} from '../services/returns.js'
export type { Rounding } from '../domain/billTotals.js'
export {
  recordPayment, cancelPayment, customerOutstanding, customerStatement, loadOpenBills,
  totalOutstandingAll,
} from '../services/payments.js'
export type {
  RecordPaymentInput, RecordPaymentResult, ReceiptMethod, CustomerStatementRow,
  OutstandingTotal,
} from '../services/payments.js'
export {
  getOrOpenSession, openSessionFor, closeSession, sessionSummary, postCashMovement, countDrawer,
  listSessions, recordPayout, sessionMovements, CashSessionClosedError,
} from '../services/cash.js'
export type { ClosedSession, PayoutResult, SessionMovement } from '../services/cash.js'
export type {
  CashMovementInput, OpenSessionInput, SessionSummary, CloseSessionResult, CashDirection, TenderMethod,
} from '../services/cash.js'
export {
  listFormats, loadFormat, formatFor, saveFormat, deleteFormat, chooseFormat, chosenFormatId,
} from '../services/formats.js'
export type {
  StoredFormat, FormatInput, SaveFormatResult, DeleteFormatResult, ChooseResult,
} from '../services/formats.js'
export * as Receipt from '../domain/receipt.js'
export type {
  ReceiptDoc, ReceiptItem, ReceiptShop, PreviewLine, DocWording,
  PlaceOfSupply, RateSummaryRow,
} from '../domain/receipt.js'
export { BILL_WORDING, formatRate, rateSummaryOf } from '../domain/receipt.js'
export { buildInvoiceHtml } from '../domain/invoiceHtml.js'
export type { InvoiceHtmlOptions } from '../domain/invoiceHtml.js'
export {
  createCustomer, updateCustomer, customerByPhone, nextCustomerCode, backfillCustomerCodes,
  archiveCustomer, restoreCustomer,
} from '../services/customers.js'
export type { ArchiveCustomerResult } from '../services/customers.js'
export type { CustomerInput, CustomerConflict, SaveCustomerResult } from '../services/customers.js'
export {
  listCustomerPayments, writeOff, recordOpeningBalance, customerAccount,
  advanceCredit, applyAdvance, refundAdvance,
} from '../services/payments.js'
export type {
  CustomerPayment, OpeningBalanceResult,
  CustomerAccount, StatementEntry, StatementKind,
  AdvanceCredit, AdvanceReceipt, ApplyAdvanceResult, RefundAdvanceResult,
} from '../services/payments.js'
export { saveDraft } from '../services/billing.js'
export type { SaveDraftResult } from '../services/billing.js'
export { listOpenDrafts, loadDraft, discardDraft, pruneEmptyDrafts } from '../services/drafts.js'
export type { OpenDraft, DraftDetail, DraftLine } from '../services/drafts.js'
export {
  createDocument, submitDocument, cancelDocument, listDocuments, loadDocument,
} from '../services/documents.js'
export type {
  DocumentKind, DocumentLineInput, CreateDocumentInput, CreateDocumentResult,
  SubmitDocumentResult, CancelDocumentResult,
  DocumentListItem, DocumentFilter, DocumentDetail, DocumentItemRow, DocumentStatus,
} from '../services/documents.js'
export { quotationToSalesOrder, receivePurchaseOrder, documentToCart } from '../services/convert.js'
export type { ConvertResult, ReceiveResult, ToCartResult, OrderCartLine } from '../services/convert.js'
export * as Totals from '../domain/billTotals.js'
export type { ComputedTotals, LineTotals, TotalsLine } from '../domain/billTotals.js'
export {
  planCustomerImport, applyCustomerImport, exportCustomers, CUSTOMER_COLUMNS,
} from '../services/customerImport.js'
export type {
  CustomerPlan, PlannedCustomer, CustomerRowProblem, CustomerImportResult,
} from '../services/customerImport.js'
