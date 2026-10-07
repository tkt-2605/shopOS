/*
 * What the counter searches and lists: products, customers and bills.
 *
 * One file each -- `catalog/products.ts`, `catalog/customers.ts` and
 * `catalog/bills.ts` -- re-exported here, where every caller has always found
 * them.
 */

export { findByBarcode, findAllByBarcode, scanChoices, productsByIds, saleUnitsFor, searchProducts } from './catalog/products.js'
export type { ProductListItem, SaleUnitOption, SearchOptions } from './catalog/products.js'
export { countCustomers, loadCustomer, searchCustomers } from './catalog/customers.js'
export type { CustomerDetail, CustomerListItem, CustomerOrder } from './catalog/customers.js'
export { countBills, listBills, loadBillDetail } from './catalog/bills.js'
export type {
  BillDetail, BillDetailItem, BillFilter, BillListItem, BillStatusFilter,
} from './catalog/bills.js'
