/*
 * @shopos/core/stock -- The shelf and what comes onto it: stock, counts, batches, valuation, suppliers and what is owed to them.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export {
  currentStock, postMovement, checkAvailability, recomputeStock, reverseVoucher,
} from '../services/stock.js'
export type { StockPosting, StockRequirement, StockShortfall, StockDrift } from '../services/stock.js'
export { productHistory, productProfit, noCostBasis } from '../repos/productHistory.js'
export type { StockMovement, ProductProfit, NoCostBasis } from '../repos/productHistory.js'
export { createStockEntry, submitStockEntry, cancelStockEntry, directionOf, signedQty } from '../services/stockEntry.js'
export type {
  StockEntryType, StockEntryLineInput, CreateStockEntryInput,
  CreateStockEntryResult, SubmitStockEntryResult,
} from '../services/stockEntry.js'
export * as Batches from '../domain/batches.js'
export {
  batchesOf, planSale, expiringBatches, batchesOnVoucher, productsWithBatches, batchTextFor, priceChoicesFor,
} from '../services/batches.js'
export type { BatchRow, SalePlan, ExpiringBatch, LineBatch } from '../services/batches.js'
export { productValuation } from '../services/stock.js'
export * as Valuation from '../domain/valuation.js'
export { reorderList, bySupplier } from '../repos/reorder.js'
export { costHints, costHint } from '../repos/costs.js'
export { listStockEntries, loadStockEntry } from '../repos/stockEntries.js'
export type { StockEntryFilter, StockEntryRow, StockEntryView, StockEntryLine, StockEntryState } from '../repos/stockEntries.js'
export type { CostHint } from '../repos/costs.js'
export { costFloors, underCost, mayAllowBelowCost } from '../services/belowCost.js'
export type { BelowCostRefusal, UnderCost, PriceToCheck } from '../services/belowCost.js'
export * as CostFloor from '../domain/costFloor.js'
export type { ReorderRow, ReorderOptions, SupplierGroup } from '../repos/reorder.js'
export { listShortfalls, countShortfalls } from '../repos/shortfalls.js'
export { lowStock } from '../repos/lowStock.js'
export type { LowStockItem } from '../repos/lowStock.js'
export type { Shortfall, ShortfallSummary } from '../repos/shortfalls.js'
export { stockValue, issuedUnitCost } from '../services/stock.js'
export {
  openCount, loadCount, listCounts, openSheet, setCounted, submitCount, cancelCount,
} from '../services/stockCount.js'
export type {
  CountScope, OpenCountInput, OpenCountResult, CountLine, CountSheet,
  CountSummary, SubmitCountResult, MovedLine,
} from '../services/stockCount.js'
export {
  listSuppliers, supplierSummaries, createSupplier, updateSupplier, archiveSupplier, restoreSupplier,
  findOrCreateSupplier, supplierPurchases, supplierItems, setSupplierOpening,
} from '../services/suppliers.js'
export type { SupplierOrder } from '../services/suppliers.js'
export type {
  Supplier, SupplierSummary, SupplierResult, PurchaseLine, SupplierItem, OpeningResult,
} from '../services/suppliers.js'
export {
  planSupplierImport, applySupplierImport, exportSuppliers, SUPPLIER_COLUMNS,
} from '../services/supplierImport.js'
export type {
  SupplierPlan, PlannedSupplier, SupplierRowProblem,
} from '../services/supplierImport.js'
/* Supplier bills and what is owed to suppliers (065). */
export { paySupplier, supplierOwed, supplierPayments } from '../services/payables.js'
export type { PaySupplierResult, SupplierPayment, SupplierPaymentMethod } from '../services/payables.js'
export { purchaseTaxes } from '../services/purchases.js'
