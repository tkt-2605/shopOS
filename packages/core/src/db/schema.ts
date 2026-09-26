/**
 * The shape of the database, as Drizzle sees it.
 *
 * Seeded once by `drizzle-kit pull` against a copy of a real shop's database
 * migrated to head, then owned here. **Every later migration edits this file by
 * hand**, in the same commit as the SQL -- `drizzle-kit generate` and
 * `drizzle-kit push` are never run, because the numbered files in
 * `packages/core/migrations` are the only thing allowed to change a shop's
 * schema, and a tool that writes DDL from a TypeScript file is a second source
 * of truth pointed at a till.
 *
 * `schemaParity.test.ts` is what makes that safe: it reads `PRAGMA table_info`
 * and `PRAGMA foreign_key_list` from a database migrated to head and compares
 * every column and every foreign key against what is declared here. A migration
 * that lands without its edit to this file fails the suite.
 *
 * ## What was changed by hand after the pull
 *
 * - **The CHECK constraints are gone.** The pull attached all 2,050 of them to
 *   all 43 tables -- the cross product -- and truncated each one at the first
 *   closing paren, so `docstatus IN (0, 1, 2)` came out as `IN (0, 1, 2`. They
 *   belong to the migrations and nothing here emits DDL, so they are not
 *   restated.
 * - **Money and quantity columns carry their brands**, through `money` and
 *   `qtyCol` in `columns.ts`. SQLite stores paise, ten-thousandths and basis
 *   points all as plain integers, and a `rate` added to a `qty` is a number the
 *   compiler is happy with.
 * - **House style**: two spaces, single quotes, no semicolons. The tool writes
 *   tabs and semicolons and nothing else in this repo does, and this file is
 *   read and edited by people from here on.
 *
 * ## drizzle-kit is not a dependency
 *
 * It was installed for the pull and removed again. Two of its three commands
 * write DDL from this file, which is the one thing that must never happen to a
 * shop's database, and a tool sitting in `devDependencies` that mostly must not
 * be run is an accident with a lead time. It could not resolve `drizzle-orm`
 * across this workspace anyway.
 *
 * To re-seed from scratch: copy a shop's database, migrate it to head, install
 * `drizzle-kit`, run `pull`, then reapply the three changes above. The parity
 * test says whether the result is right, which is the same answer it gives for
 * an edit made by hand.
 */

import {
  sqliteTable, text, integer, foreignKey, primaryKey, index, uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { money, qtyCol } from './columns.js'
import { ZERO } from '../money.js'
import { QTY_ZERO } from '../quantity.js'

export const settings = sqliteTable('settings', {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
  updatedAt: text('updated_at').notNull(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
})

export const roles = sqliteTable('roles', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  description: text(),
  isSystem: integer('is_system').default(0).notNull(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const rolePermissions = sqliteTable('role_permissions', {
  id: text().primaryKey().notNull(),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  resource: text().notNull(),
  canRead: integer('can_read').default(0).notNull(),
  canCreate: integer('can_create').default(0).notNull(),
  canWrite: integer('can_write').default(0).notNull(),
  canDelete: integer('can_delete').default(0).notNull(),
  canSubmit: integer('can_submit').default(0).notNull(),
  canCancel: integer('can_cancel').default(0).notNull(),
  canAmend: integer('can_amend').default(0).notNull(),
})

export const rolePages = sqliteTable('role_pages', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  pageKey: text('page_key').notNull(),
  visible: integer().default(0).notNull(),
}, (table) => [
  primaryKey({ columns: [table.roleId, table.pageKey], name: 'role_pages_role_id_page_key_pk'})
])

export const users = sqliteTable('users', {
  id: text().primaryKey().notNull(),
  username: text().notNull(),
  fullName: text('full_name'),
  roleId: text('role_id').notNull().references(() => roles.id),
  passwordHash: text('password_hash').notNull(),
  isActive: integer('is_active').default(1).notNull(),
  failedLogins: integer('failed_logins').default(0).notNull(),
  lockedUntil: text('locked_until'),
  lastLoginAt: text('last_login_at'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_users_role').on(table.roleId),
])

/**
 * A sign-in, recorded against the till it happened on.
 *
 * One row per user per till, with the id derived from exactly that pair, so no
 * two tills ever write the same row and there is nothing for the merge to
 * settle. `users.last_login_at` and `users.failed_logins` are the shop's shared
 * baseline from before 049 and are never written again -- see the migration for
 * why a backfill was not possible and why that turns out to be the better
 * answer.
 */
export const userSessions = sqliteTable('user_sessions', {
  id: text().primaryKey().notNull(),
  userId: text('user_id').notNull().references(() => users.id),
  deviceId: text('device_id').notNull(),
  lastLoginAt: text('last_login_at'),
  failedLogins: integer('failed_logins').default(0).notNull(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_user_sessions_user').on(table.userId),
])

export const categories = sqliteTable('categories', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  parentId: text('parent_id'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  foreignKey(() => ({
    columns: [table.parentId],
    foreignColumns: [table.id],
    name: 'categories_parent_id_categories_id_fk'
  })),
])

export const products = sqliteTable('products', {
  id: text().primaryKey().notNull(),
  code: text(),
  name: text().notNull(),
  brand: text(),
  categoryId: text('category_id').references(() => categories.id),
  baseUnit: text('base_unit').default('piece').notNull(),
  barcode: text(),
  hsnCode: text('hsn_code'),
  taxRateBp: integer('tax_rate_bp').default(0).notNull(),
  baseRate: money('base_rate').default(ZERO).notNull(),
  mrp: money(),
  isStockTracked: integer('is_stock_tracked').default(1).notNull(),
  discountBlocked: integer('discount_blocked').default(0).notNull(),
  returnBlocked: integer('return_blocked').default(0).notNull(),
  isActive: integer('is_active').default(1).notNull(),
  imagePath: text('image_path'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
  loyaltyBlocked: integer('loyalty_blocked').default(0).notNull(),
  minMarginBp: integer('min_margin_bp'),
  reorderLevel: qtyCol('reorder_level'),
  reorderQty: qtyCol('reorder_qty'),
  parentProductId: text('parent_product_id'),
  variantLabel: text('variant_label'),
}, (table) => [
  index('idx_products_parent').on(table.parentProductId),
  index('idx_products_reorder').on(table.reorderLevel),
  index('idx_products_category').on(table.categoryId),
  index('idx_products_active').on(table.isActive),
  index('idx_products_name').on(table.name),
  index('idx_products_barcode').on(table.barcode),
  foreignKey(() => ({
    columns: [table.parentProductId],
    foreignColumns: [table.id],
    name: 'products_parent_product_id_products_id_fk'
  })),
])

export const productUnits = sqliteTable('product_units', {
  id: text().primaryKey().notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  saleUnit: text('sale_unit').notNull(),
  baseUnits: qtyCol('base_units').notNull(),
  isDefault: integer('is_default').default(0).notNull(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  /** Taken off the item (056). */
  deletedAt: text('deleted_at'),
})

export const priceLists = sqliteTable('price_lists', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  isDefault: integer('is_default').default(0).notNull(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
  /* Vestigial since 043, which moved the answer to a `default_price_list_id`
     setting because an index cannot express a rule about a shop. Nothing reads
     or writes it; it is still here only because dropping a column means
     rebuilding a table `item_prices` and `customers` both point at. */
})

export const itemPrices = sqliteTable('item_prices', {
  id: text().primaryKey().notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  priceListId: text('price_list_id').notNull().references(() => priceLists.id),
  saleUnit: text('sale_unit').notNull(),
  minQty: qtyCol('min_qty').default(QTY_ZERO).notNull(),
  rate: money().notNull(),
  validFrom: text('valid_from'),
  validTo: text('valid_to'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_item_prices_lookup').on(table.productId, table.priceListId, table.saleUnit),
])

export const customers = sqliteTable('customers', {
  id: text().primaryKey().notNull(),
  code: text(),
  name: text().notNull(),
  phone: text(),
  email: text(),
  gstin: text(),
  address: text(),
  stateCode: text('state_code'),
  priceListId: text('price_list_id').references(() => priceLists.id),
  creditLimit: money('credit_limit').default(ZERO).notNull(),
  creditEnforcement: text('credit_enforcement').default('hard').notNull(),
  isActive: integer('is_active').default(1).notNull(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_customers_name').on(table.name),
  index('idx_customers_phone').on(table.phone),
])

export const suppliers = sqliteTable('suppliers', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  phone: text(),
  gstin: text(),
  address: text(),
  isActive: integer('is_active').default(1).notNull(),
  /** What the shop owed them when the books moved. Negative: they hold ours. */
  openingBalance: money('opening_balance').default(ZERO).notNull(),
  /** The day the old book closed. Null means nobody has ever said. */
  openingAsOf: text('opening_as_of'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const registers = sqliteTable('registers', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  prefix: text().notNull(),
  isActive: integer('is_active').default(1).notNull(),
  /** The device that says it sits here. Null until some till has claimed it. */
  claimedBy: text('claimed_by'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  /** When the claim was last renewed. Null means never — see migration 045. */
  claimedAt: text('claimed_at'),
})

export const cashSessions = sqliteTable('cash_sessions', {
  id: text().primaryKey().notNull(),
  registerId: text('register_id').notNull().references(() => registers.id),
  docstatus: integer().default(0).notNull(),
  openedBy: text('opened_by').notNull().references(() => users.id),
  openedAt: text('opened_at').notNull(),
  openingCash: money('opening_cash').default(ZERO).notNull(),
  closedBy: text('closed_by').references(() => users.id),
  closedAt: text('closed_at'),
  expectedCash: money('expected_cash'),
  actualCash: money('actual_cash'),
  variance: money(),
  notes: text(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  /**
   * `UNIQUE (register_id) WHERE closed_at IS NULL`, and unlike the one 043 took
   * off `price_lists` it stays. The difference is worth writing down, because the
   * two look identical and only one of them is a rule two tills can keep.
   *
   * A partial unique index is a statement about one file. It is safe under
   * replication only when the rows it constrains can be written by one machine
   * in the first place — and a cash session belongs to a register, a register is
   * claimed by one till (`registers.claimed_by`, migration 037), and a till that
   * does not hold the claim will not bill on it at all: `resolveDeviceRegister`
   * returns null and the app keeps that machine off the billing screen. So two
   * tills cannot both open a drawer on one counter, which means the index is
   * never asked to arbitrate between them.
   *
   * The default price list had no such owner. It is one fact about the whole
   * shop, so every till was entitled to set it, and the index then refused the
   * second answer to arrive rather than settling it.
   *
   * What would break this: letting two tills share a counter. That is refused
   * today, loudly, by `SAME_REGISTER` at the next sync — and if it is ever
   * allowed, this index has to go at the same time.
   */
  uniqueIndex('idx_cash_sessions_one_open').on(table.registerId),
])

export const cashMovements = sqliteTable('cash_movements', {
  id: text().primaryKey().notNull(),
  sessionId: text('session_id').notNull().references(() => cashSessions.id),
  direction: text().notNull(),
  amount: money().notNull(),
  method: text().default('cash').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id'),
  reference: text(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_cash_movements_session').on(table.sessionId),
])

export const bills = sqliteTable('bills', {
  id: text().primaryKey().notNull(),
  docNo: text('doc_no').notNull(),
  docstatus: integer().default(0).notNull(),
  amendedFrom: text('amended_from'),
  registerId: text('register_id').notNull().references(() => registers.id),
  sessionId: text('session_id').references(() => cashSessions.id),
  customerId: text('customer_id').references(() => customers.id),
  customerName: text('customer_name'),
  postingDate: text('posting_date').notNull(),
  subtotal: money().default(ZERO).notNull(),
  discount: money().default(ZERO).notNull(),
  taxableTotal: money('taxable_total').default(ZERO).notNull(),
  taxTotal: money('tax_total').default(ZERO).notNull(),
  roundOff: money('round_off').default(ZERO).notNull(),
  grandTotal: money('grand_total').default(ZERO).notNull(),
  paidTotal: money('paid_total').default(ZERO).notNull(),
  creditTotal: money('credit_total').default(ZERO).notNull(),
  placeOfSupply: text('place_of_supply'),
  idempotencyKey: text('idempotency_key'),
  notes: text(),
  createdBy: text('created_by').notNull().references(() => users.id),
  cancelledBy: text('cancelled_by').references(() => users.id),
  cancelledAt: text('cancelled_at'),
  cancelReason: text('cancel_reason'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  kind: text().default('sale').notNull(),
  convertedFrom: text('converted_from').references(() => documents.id),
  supplyType: text('supply_type'),
  customerGstin: text('customer_gstin'),
  customerAddress: text('customer_address'),
  customerStateCode: text('customer_state_code'),
  reverseCharge: integer('reverse_charge').default(0).notNull(),
}, (table) => [
  index('idx_bills_ledger').on(table.kind, table.docstatus, table.postingDate),
  index('idx_bills_converted').on(table.convertedFrom),
  index('idx_bills_kind').on(table.kind),
  index('idx_bills_status').on(table.docstatus),
  index('idx_bills_date').on(table.postingDate),
  index('idx_bills_customer').on(table.customerId),
  foreignKey(() => ({
    columns: [table.amendedFrom],
    foreignColumns: [table.id],
    name: 'bills_amended_from_bills_id_fk'
  })),
  index('idx_bills_amended_from').on(table.amendedFrom),
])

export const billItems = sqliteTable('bill_items', {
  id: text().primaryKey().notNull(),
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  idx: integer().notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  productName: text('product_name').notNull(),
  hsnCode: text('hsn_code'),
  saleUnit: text('sale_unit').notNull(),
  qty: qtyCol().notNull(),
  baseQty: qtyCol('base_qty').notNull(),
  rate: money().notNull(),
  mrp: money(),
  discount: money().default(ZERO).notNull(),
  lineTotal: money('line_total').notNull(),
  taxableValue: money('taxable_value').default(ZERO).notNull(),
  taxRateBp: integer('tax_rate_bp').default(0).notNull(),
  cgstAmount: money('cgst_amount').default(ZERO).notNull(),
  sgstAmount: money('sgst_amount').default(ZERO).notNull(),
  igstAmount: money('igst_amount').default(ZERO).notNull(),
  priceSource: text('price_source').notNull(),
  priceSourceId: text('price_source_id'),
  returnedQty: qtyCol('returned_qty').default(QTY_ZERO).notNull(),
  discountBlocked: integer('discount_blocked').default(0).notNull(),
  loyaltyBlocked: integer('loyalty_blocked').default(0).notNull(),
}, (table) => [
  index('idx_bill_items_product').on(table.productId),
  index('idx_bill_items_bill').on(table.billId),
])

export const billPayments = sqliteTable('bill_payments', {
  id: text().primaryKey().notNull(),
  billId: text('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  method: text().notNull(),
  amount: money().notNull(),
  reference: text(),
}, (table) => [
  index('idx_bill_payments_bill').on(table.billId),
])

export const salesReturns = sqliteTable('sales_returns', {
  id: text().primaryKey().notNull(),
  docNo: text('doc_no').notNull(),
  docstatus: integer().default(0).notNull(),
  amendedFrom: text('amended_from'),
  billId: text('bill_id').notNull().references(() => bills.id),
  postingDate: text('posting_date').notNull(),
  refundTotal: money('refund_total').default(ZERO).notNull(),
  taxReversed: money('tax_reversed').default(ZERO).notNull(),
  refundMethod: text('refund_method').notNull(),
  reason: text(),
  createdBy: text('created_by').notNull().references(() => users.id),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  refundCash: money('refund_cash').default(ZERO).notNull(),
  pointsRestored: integer('points_restored').default(0).notNull(),
  pointsRemoved: integer('points_removed').default(0).notNull(),
  creditNoteId: text('credit_note_id').references(() => paymentEntries.id),
}, (table) => [
  index('idx_sales_returns_bill').on(table.billId),
  foreignKey(() => ({
    columns: [table.amendedFrom],
    foreignColumns: [table.id],
    name: 'sales_returns_amended_from_sales_returns_id_fk'
  })),
  index('idx_sales_returns_date').on(table.postingDate),
])

export const salesReturnItems = sqliteTable('sales_return_items', {
  id: text().primaryKey().notNull(),
  returnId: text('return_id').notNull().references(() => salesReturns.id, { onDelete: 'cascade' }),
  billItemId: text('bill_item_id').notNull().references(() => billItems.id),
  productId: text('product_id').notNull().references(() => products.id),
  qty: qtyCol().notNull(),
  baseQty: qtyCol('base_qty').notNull(),
  refundAmount: money('refund_amount').notNull(),
  taxableValue: money('taxable_value').default(ZERO).notNull(),
  cgstAmount: money('cgst_amount').default(ZERO).notNull(),
  sgstAmount: money('sgst_amount').default(ZERO).notNull(),
  igstAmount: money('igst_amount').default(ZERO).notNull(),
  hsnCode: text('hsn_code'),
  taxRateBp: integer('tax_rate_bp').default(0).notNull(),
}, (table) => [
  index('idx_sales_return_items_return').on(table.returnId),
  index('idx_sales_return_items_bill_item').on(table.billItemId),
])

export const paymentEntries = sqliteTable('payment_entries', {
  id: text().primaryKey().notNull(),
  docNo: text('doc_no').notNull(),
  docstatus: integer().default(0).notNull(),
  amendedFrom: text('amended_from'),
  partyType: text('party_type').notNull(),
  customerId: text('customer_id').references(() => customers.id),
  supplierId: text('supplier_id').references(() => suppliers.id),
  postingDate: text('posting_date').notNull(),
  method: text().notNull(),
  amount: money().notNull(),
  reference: text(),
  notes: text(),
  createdBy: text('created_by').notNull().references(() => users.id),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  direction: text().default('in').notNull(),
}, (table) => [
  index('idx_payment_entries_refunds').on(table.customerId, table.postingDate),
  index('idx_payment_entries_customer').on(table.customerId),
  foreignKey(() => ({
    columns: [table.amendedFrom],
    foreignColumns: [table.id],
    name: 'payment_entries_amended_from_payment_entries_id_fk'
  })),
  index('idx_payment_entries_date').on(table.postingDate),
])

export const paymentAllocations = sqliteTable('payment_allocations', {
  id: text().primaryKey().notNull(),
  paymentId: text('payment_id').notNull().references(() => paymentEntries.id, { onDelete: 'cascade' }),
  billId: text('bill_id').notNull().references(() => bills.id),
  amount: money().notNull(),
}, (table) => [
  index('idx_payment_allocations_bill').on(table.billId),
])

export const stockEntries = sqliteTable('stock_entries', {
  id: text().primaryKey().notNull(),
  docNo: text('doc_no').notNull(),
  docstatus: integer().default(0).notNull(),
  amendedFrom: text('amended_from'),
  entryType: text('entry_type').notNull(),
  postingDate: text('posting_date').notNull(),
  supplierId: text('supplier_id').references(() => suppliers.id),
  supplierName: text('supplier_name'),
  reference: text(),
  notes: text(),
  createdBy: text('created_by').notNull().references(() => users.id),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  foreignKey(() => ({
    columns: [table.amendedFrom],
    foreignColumns: [table.id],
    name: 'stock_entries_amended_from_stock_entries_id_fk'
  })),
  index('idx_stock_entries_date').on(table.postingDate),
])

export const stockEntryItems = sqliteTable('stock_entry_items', {
  id: text().primaryKey().notNull(),
  entryId: text('entry_id').notNull().references(() => stockEntries.id, { onDelete: 'cascade' }),
  productId: text('product_id').notNull().references(() => products.id),
  qty: qtyCol().notNull(),
  unitCost: money('unit_cost').default(ZERO).notNull(),
}, (table) => [
  index('idx_stock_entry_items_entry').on(table.entryId),
])

export const stockLedger = sqliteTable('stock_ledger', {
  id: text().primaryKey().notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  postingDate: text('posting_date').notNull(),
  qtyChange: qtyCol('qty_change').notNull(),
  unitCost: money('unit_cost'),
  balanceQty: qtyCol('balance_qty').notNull(),
  voucherType: text('voucher_type').notNull(),
  voucherId: text('voucher_id').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
  /** What the movement was worth, signed, in paise (058). The rate is derived from it. */
  valueChange: money('value_change'),
  /** The till that posted it, whose shelf count `balance_qty` is (060). */
  deviceId: text('device_id'),
}, (table) => [
  index('idx_stock_ledger_voucher').on(table.voucherType, table.voucherId),
  index('idx_stock_ledger_product').on(table.productId, table.postingDate),
  index('idx_stock_ledger_made').on(table.productId, table.id),
])

export const productStock = sqliteTable('product_stock', {
  productId: text('product_id').primaryKey().notNull().references(() => products.id),
  qtyOnHand: qtyCol('qty_on_hand').default(QTY_ZERO).notNull(),
  updatedAt: text('updated_at').notNull(),
  stockValue: money('stock_value').default(ZERO).notNull(),
})

export const loyaltyEntries = sqliteTable('loyalty_entries', {
  id: text().primaryKey().notNull(),
  customerId: text('customer_id').notNull().references(() => customers.id),
  billId: text('bill_id').references(() => bills.id),
  points: integer().notNull(),
  consumed: integer().default(0).notNull(),
  earnedAt: text('earned_at').notNull(),
  expiresAt: text('expires_at'),
  cancelledAt: text('cancelled_at'),
  createdAt: text('created_at').notNull(),
  rev: integer().default(1).notNull(),
  updatedAt: text('updated_at'),
  /** What the entry was worth when earned; `points` is that less returns (053). */
  earned: integer(),
}, (table) => [
  index('idx_loyalty_entries_customer').on(table.customerId, table.expiresAt),
  index('idx_loyalty_entries_bill').on(table.billId),
])

export const loyaltyRedemptions = sqliteTable('loyalty_redemptions', {
  id: text().primaryKey().notNull(),
  customerId: text('customer_id').notNull().references(() => customers.id),
  billId: text('bill_id').notNull().references(() => bills.id),
  loyaltyEntryId: text('loyalty_entry_id').notNull().references(() => loyaltyEntries.id),
  points: integer().notNull(),
  reversedAt: text('reversed_at'),
  createdAt: text('created_at').notNull(),
  restored: integer().default(0).notNull(),
}, (table) => [
  index('idx_loyalty_redemptions_bill').on(table.billId),
  index('idx_loyalty_redemptions_entry').on(table.loyaltyEntryId),
])

export const auditLog = sqliteTable('audit_log', {
  id: text().primaryKey().notNull(),
  entity: text().notNull(),
  entityId: text('entity_id').notNull(),
  action: text().notNull(),
  actorId: text('actor_id'),
  docstatusFrom: integer('docstatus_from'),
  docstatusTo: integer('docstatus_to'),
  diff: text(),
  at: text().notNull(),
  deviceId: text('device_id'),
}, (table) => [
  index('idx_audit_actor').on(table.actorId, table.at),
  index('idx_audit_device').on(table.deviceId, table.at),
  index('idx_audit_at').on(table.at),
  index('idx_audit_entity').on(table.entity, table.entityId),
])

export const docSequences = sqliteTable('doc_sequences', {
  scope: text().primaryKey().notNull(),
  lastValue: integer('last_value').default(0).notNull(),
})

export const attachments = sqliteTable('attachments', {
  id: text().primaryKey().notNull(),
  entity: text().notNull(),
  entityId: text('entity_id').notNull(),
  fileName: text('file_name').notNull(),
  storedPath: text('stored_path').notNull(),
  mime: text().notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text().notNull(),
  caption: text(),
  createdBy: text('created_by').notNull().references(() => users.id),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_attachments_sha').on(table.sha256),
  index('idx_attachments_entity').on(table.entity, table.entityId),
])

export const stockCounts = sqliteTable('stock_counts', {
  id: text().primaryKey().notNull(),
  docNo: text('doc_no').notNull(),
  docstatus: integer().default(0).notNull(),
  scope: text().default('all').notNull(),
  categoryId: text('category_id').references(() => categories.id),
  note: text(),
  openedAt: text('opened_at').notNull(),
  postingDate: text('posting_date').notNull(),
  entryId: text('entry_id').references(() => stockEntries.id),
  createdBy: text('created_by').notNull().references(() => users.id),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_stock_counts_open').on(table.docstatus),
])

export const stockCountItems = sqliteTable('stock_count_items', {
  id: text().primaryKey().notNull(),
  countId: text('count_id').notNull().references(() => stockCounts.id),
  productId: text('product_id').notNull().references(() => products.id),
  expectedQty: qtyCol('expected_qty').notNull(),
  countedQty: qtyCol('counted_qty'),
  unitCost: money('unit_cost'),
}, (table) => [
  index('idx_stock_count_items_count').on(table.countId),
])

export const productBarcodes = sqliteTable('product_barcodes', {
  id: text().primaryKey().notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  barcode: text().notNull(),
  label: text(),
  isPrimary: integer('is_primary').default(0).notNull(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  /** Taken off the item (056). A removal is an edit, so it merges like one. */
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_product_barcodes_product').on(table.productId),
  uniqueIndex('idx_product_barcodes_code').on(table.barcode),
])

export const customerItemPrices = sqliteTable('customer_item_prices', {
  id: text().primaryKey().notNull(),
  customerId: text('customer_id').notNull().references(() => customers.id),
  productId: text('product_id').notNull().references(() => products.id),
  saleUnit: text('sale_unit').notNull(),
  minQty: qtyCol('min_qty').default(QTY_ZERO).notNull(),
  rate: money().notNull(),
  validFrom: text('valid_from'),
  validTo: text('valid_to'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_customer_item_prices_lookup').on(table.customerId, table.productId, table.saleUnit),
])

export const docFormats = sqliteTable('doc_formats', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  paper: text().notNull(),
  kinds: text().notNull(),
  blocks: text().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  template: text(),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  deletedAt: text('deleted_at'),
})

export const documents = sqliteTable('documents', {
  id: text().primaryKey().notNull(),
  docNo: text('doc_no').notNull(),
  kind: text().notNull(),
  docstatus: integer().default(0).notNull(),
  registerId: text('register_id').notNull().references(() => registers.id),
  customerId: text('customer_id').references(() => customers.id),
  customerName: text('customer_name'),
  supplierId: text('supplier_id').references(() => suppliers.id),
  supplierName: text('supplier_name'),
  postingDate: text('posting_date').notNull(),
  validUntil: text('valid_until'),
  subtotal: money().default(ZERO).notNull(),
  discount: money().default(ZERO).notNull(),
  taxableTotal: money('taxable_total').default(ZERO).notNull(),
  taxTotal: money('tax_total').default(ZERO).notNull(),
  roundOff: money('round_off').default(ZERO).notNull(),
  grandTotal: money('grand_total').default(ZERO).notNull(),
  placeOfSupply: text('place_of_supply'),
  notes: text(),
  terms: text(),
  convertedFrom: text('converted_from'),
  createdBy: text('created_by').notNull().references(() => users.id),
  cancelledBy: text('cancelled_by').references(() => users.id),
  cancelledAt: text('cancelled_at'),
  cancelReason: text('cancel_reason'),
  rev: integer().default(1).notNull(),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_documents_converted').on(table.convertedFrom),
  index('idx_documents_supplier').on(table.supplierId),
  index('idx_documents_customer').on(table.customerId),
  index('idx_documents_kind_date').on(table.kind, table.postingDate),
  foreignKey(() => ({
    columns: [table.convertedFrom],
    foreignColumns: [table.id],
    name: 'documents_converted_from_documents_id_fk'
  })),
])

export const documentItems = sqliteTable('document_items', {
  id: text().primaryKey().notNull(),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  idx: integer().notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  productName: text('product_name').notNull(),
  hsnCode: text('hsn_code'),
  saleUnit: text('sale_unit').notNull(),
  qty: qtyCol().notNull(),
  baseQty: qtyCol('base_qty').notNull(),
  rate: money().notNull(),
  discount: money().default(ZERO).notNull(),
  lineTotal: money('line_total').notNull(),
  taxableValue: money('taxable_value').default(ZERO).notNull(),
  taxRateBp: integer('tax_rate_bp').default(0).notNull(),
  cgstAmount: money('cgst_amount').default(ZERO).notNull(),
  sgstAmount: money('sgst_amount').default(ZERO).notNull(),
  igstAmount: money('igst_amount').default(ZERO).notNull(),
  fulfilledQty: qtyCol('fulfilled_qty').default(QTY_ZERO).notNull(),
}, (table) => [
  index('idx_document_items_doc').on(table.documentId),
])

export const billFulfilments = sqliteTable('bill_fulfilments', {
  id: text().primaryKey().notNull(),
  billId: text('bill_id').notNull().references(() => bills.id),
  documentId: text('document_id').notNull().references(() => documents.id),
  documentItemId: text('document_item_id').notNull().references(() => documentItems.id),
  qty: qtyCol().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_bill_fulfilments_document').on(table.documentId),
  index('idx_bill_fulfilments_bill').on(table.billId),
  index('idx_bill_fulfilments_document_item').on(table.documentItemId),
])

/** What a quotation or purchase order line became, one row per conversion (054). */
export const documentFulfilments = sqliteTable('document_fulfilments', {
  id: text().primaryKey().notNull(),
  documentId: text('document_id').notNull().references(() => documents.id),
  documentItemId: text('document_item_id').notNull().references(() => documentItems.id),
  qty: qtyCol().notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_document_fulfilments_item').on(table.documentItemId),
  index('idx_document_fulfilments_document').on(table.documentId),
])

export const changeFeed = sqliteTable('change_feed', {
  seq: integer().primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  rowId: text('row_id').notNull(),
  op: text().notNull(),
  at: text().notNull(),
  /** The till this row arrived from, or null when it was written here. */
  originDevice: text('origin_device'),
  /**
   * For a delete, the `rev` the row was at when it went. Null everywhere else,
   * and null for a delete this till cannot account for. See migration 040.
   */
  deletedRev: integer('deleted_rev'),
}, (table) => [
  index('idx_change_feed_origin').on(table.originDevice, table.seq),
])

export const syncState = sqliteTable('sync_state', {
  id: integer().primaryKey(),
  applying: integer().default(0).notNull(),
})

export const syncPeers = sqliteTable('sync_peers', {
  deviceId: text('device_id').primaryKey().notNull(),
  label: text(),
  theirCursor: integer('their_cursor').default(0).notNull(),
  myCursor: integer('my_cursor').default(0).notNull(),
  lastAgreedAt: text('last_agreed_at'),
  createdAt: text('created_at').notNull(),
  secret: text(),
  address: text(),
  lastError: text('last_error'),
  lastTriedAt: text('last_tried_at'),
  /**
   * The shape of this peer: `lan` asks and answers, `cloud` answers and never
   * asks, `none` asks and cannot answer. Migration 044 carries the argument —
   * it used to be inferred from `address IS NOT NULL`, which gets a phone right
   * by accident and a cloud peer wrong.
   */
  reach: text().default('lan').notNull(),
  /** The last feed position this peer reported. `their_head - their_cursor` is
   *  how far behind that till this one is. */
  theirHead: integer('their_head').default(0).notNull(),
  /**
   * When that head was reported. Null means never — which is the one thing a
   * `NOT NULL DEFAULT 0` column could not say, because 0 is also what a peer
   * whose feed has been pruned empty honestly reports. See migration 048.
   */
  headSaidAt: text('head_said_at'),
  /** How far this peer's clock is from ours, as of the last handshake. Zero
   *  means level, or a peer too old to say. See migration 046. */
  clockSkewMs: integer('clock_skew_ms').default(0).notNull(),
  /**
   * The peer's certificate fingerprint, exchanged at pairing. Null everywhere
   * today, because nothing serves TLS yet — see migration 047 for why the
   * column exists before the thing that fills it.
   */
  fingerprint: text(),
})

export const syncQuarantine = sqliteTable('sync_quarantine', {
  id: text().primaryKey().notNull(),
  at: text().notNull(),
  peerDevice: text('peer_device'),
  tableName: text('table_name').notNull(),
  rowId: text('row_id').notNull(),
  op: text().notNull(),
  reason: text().notNull(),
  record: text().notNull(),
  acknowledged: integer().default(0).notNull(),
}, (table) => [
  index('idx_sync_quarantine_at').on(table.acknowledged, table.at),
])

export const syncConflicts = sqliteTable('sync_conflicts', {
  id: text().primaryKey().notNull(),
  at: text().notNull(),
  peerDevice: text('peer_device'),
  tableName: text('table_name').notNull(),
  rowId: text('row_id').notNull(),
  winner: text().notNull(),
  explain: text().notNull(),
  acknowledged: integer().default(0).notNull(),
}, (table) => [
  index('idx_sync_conflicts_at').on(table.acknowledged, table.at),
])

