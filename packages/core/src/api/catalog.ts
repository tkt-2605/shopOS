/*
 * @shopos/core/catalog -- Items, their prices, units, barcodes and groups, and finding them.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export * as Pricing from '../domain/pricing.js'
export { loadPriceCandidates, defaultPriceListId, resolveSaleUnit, lineMrp } from '../repos/pricing.js'
export {
  searchProducts, findByBarcode, findAllByBarcode, scanChoices, productsByIds, saleUnitsFor, searchCustomers,
  countCustomers, listBills, countBills, loadBillDetail, loadCustomer,
} from '../repos/catalog.js'
export type {
  BillFilter, BillStatusFilter,
  ProductListItem, SearchOptions, SaleUnitOption, CustomerListItem, CustomerDetail,
  BillListItem, BillDetail, BillDetailItem, CustomerOrder,
} from '../repos/catalog.js'
export { taxLikeName, taxForHsn, nameWords } from '../repos/catalog/taxLikes.js'
export type { TaxLike } from '../repos/catalog/taxLikes.js'
export { setProductActive, saveProductDetails } from '../services/products.js'
export type { ProductDetails, SaveProductResult } from '../services/products.js'
export {
  listUnits, setUnits, renameBaseUnit, listPriceLists, createPriceList, updatePriceList,
  archivePriceList, restorePriceList,
  listItemPrices, setItemPrice, removeItemPrice,
  listCustomerPrices, setCustomerPrice, removeCustomerPrice, setCustomerPriceList, customerPriceListId,
  setLadder, setCustomerLadder, ladderFor, customerLadderFor, laddersFor,
  perBaseUnit, customersOnList, itemsPricedTwice, settleDoublePrice, pricesElsewhere, unitPrices, setUnitPrices,
  exportLadders, planLadderImport, applyLadderImport, LADDER_COLUMNS,
} from '../services/pricing.js'
export type {
  SaleUnit, SaleUnitInput, SetUnitsResult, RenameBaseUnitResult, PriceList, PriceListResult,
  ArchivePriceListResult,
  ItemPrice, ItemPriceInput, ItemPriceResult, CustomerPrice, SetLadderResult,
  DoublePrice, SettleResult, PriceElsewhere, UnitPrice, UnitPriceInput, SetUnitPricesResult,
  LadderPlan, PlannedLadder, LadderTarget, LadderProblem, LadderRowProblem, LadderImportResult,
} from '../services/pricing.js'
export * as Ladder from '../domain/ladder.js'
export type { Rung, LadderRow, RowsResult } from '../domain/ladder.js'
export {
  listCategories, createCategory, renameCategory, removeCategory, setProductCategory,
  setVariantOf, variantFamily,
} from '../services/grouping.js'
export type { Category, CategoryResult, VariantMember, VariantResult } from '../services/grouping.js'
export { listBarcodes, setBarcodes, productIdForBarcode, productIdsForBarcode, barcodesTaken, sharedBarcodes } from '../services/barcodes.js'
export type { Barcode, BarcodeInput, SetBarcodesResult, SharedBarcode, BarcodeOnSeveral } from '../services/barcodes.js'
export { pricingContextFor, resolveLinePrice } from '../repos/pricing.js'
export type { BillPricingContext, ResolvedLinePrice } from '../repos/pricing.js'
export {
  planImport, applyImport, exportCatalogue, IMPORT_COLUMNS,
} from '../services/import.js'
export type {
  ImportPlan, PlannedRow, ImportResult, CatalogueImportResult, ImportAction, RowProblem,
} from '../services/import.js'
