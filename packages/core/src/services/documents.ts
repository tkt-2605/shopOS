/*
 * In pieces by job: `documents/types.ts` is what callers pass, `documents/create.ts`
 * raises one, `documents/lifecycle.ts` submits and cancels, `documents/read.ts`
 * lists and loads, and `documents/fulfilment.ts` marks an order off as bills are
 * taken against it. Re-exported here, where callers have always found them.
 */

/**
 * Quotations, sales orders and purchase orders.
 *
 * One engine for three documents, because they differ in who they are addressed
 * to and what they turn into — not in what they are. Each is a party, a list of
 * lines, a set of totals and a promise.
 *
 * Nothing here moves stock. A submitted order writes no ledger row: that is what
 * `affectsLedgers` decides, and these answer no. Reserving stock against an
 * order would touch every stock query in the product and is its own decision.
 *
 * Prices are not resolved differently from the counter. `resolveLinePrice` and
 * `computeTotals` are the same functions `billing.ts` calls, with the same
 * arguments — a quotation that quoted a price the till then disagreed with
 * would be worse than no quotation at all.
 */

export type {
  CreateDocumentInput, CreateDocumentResult, DocumentKind, DocumentLineInput,
} from './documents/types.js'
export { createDocument } from './documents/create.js'
export { editDraftDocument } from './documents/edit.js'
export type { EditDraftInput, EditDraftResult } from './documents/edit.js'
export { cancelDocument, submitDocument } from './documents/lifecycle.js'
export type { CancelDocumentResult, SubmitDocumentResult } from './documents/lifecycle.js'
export { listDocuments, loadDocument } from './documents/read.js'
export type {
  DocumentDetail, DocumentFilter, DocumentItemRow, DocumentListItem, DocumentStatus,
} from './documents/read.js'
export { applyBillFulfilment, reverseBillFulfilment } from './documents/fulfilment.js'
