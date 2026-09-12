export * as Money from './money.js'
export * as Quantity from './quantity.js'
export { newId, newDeviceId, timestampOf } from './ids.js'

export type { SqlDriver, Row, SqlValue, ExecResult } from './db/driver.js'
export { SqlError } from './db/driver.js'
export { migrate, currentVersion, type Migration } from './db/migrate.js'
export { createTauriDriver, backupDatabase } from './db/tauri-driver.js'

export * as Tax from './domain/tax.js'
export * as Pricing from './domain/pricing.js'
export * as Loyalty from './domain/loyalty.js'
export * as Credit from './domain/credit.js'

export * as DocStatus from './integrity/docstatus.js'
export * as Permissions from './integrity/permissions.js'
export { checkLinks, assertDeletable, LinkedRecordError, LINK_RULES } from './integrity/links.js'
export { writeAudit, writeActivity, diffFields } from './integrity/audit.js'
export type { AuditAction, AuditContext, AuditRecord, FieldDiff } from './integrity/audit.js'

export { bootstrap, setSetting, getSetting } from './services/bootstrap.js'
export type { BootstrapOptions, BootstrapResult } from './services/bootstrap.js'

export {
  createBill, submitBill, cancelBill, amendBill, loadLoyaltyProgram, billSummary,
} from './services/billing.js'
export type {
  BillLineInput, CreateBillInput, CreateBillResult,
  PaymentInput, PaymentMethod, SubmitBillInput, SubmitBillResult,
  CancelBillResult, BillTotals,
} from './services/billing.js'

export {
  currentStock, postMovement, checkAvailability, recomputeStock, reverseVoucher,
} from './services/stock.js'
export type { StockPosting, StockRequirement, StockShortfall, StockDrift } from './services/stock.js'

export { nextDocNo, peekDocNo, fiscalYear } from './services/numbering.js'
export type { DocType } from './services/numbering.js'

export { loadPriceCandidates, defaultPriceListId, resolveSaleUnit } from './repos/pricing.js'

export { createReturn, submitReturn, cancelReturn, returnableQty } from './services/returns.js'
export type {
  ReturnLineInput, CreateReturnInput, CreateReturnResult, SubmitReturnResult, RefundMethod,
} from './services/returns.js'

export {
  recordPayment, cancelPayment, customerOutstanding, customerStatement, loadOpenBills,
} from './services/payments.js'
export type {
  RecordPaymentInput, RecordPaymentResult, ReceiptMethod, CustomerStatementRow,
} from './services/payments.js'

export {
  getOrOpenSession, openSessionFor, closeSession, sessionSummary, postCashMovement, countDrawer,
} from './services/cash.js'
export type {
  CashMovementInput, OpenSessionInput, SessionSummary, CloseSessionResult, CashDirection, TenderMethod,
} from './services/cash.js'

export { createStockEntry, submitStockEntry, cancelStockEntry } from './services/stockEntry.js'
export type {
  StockEntryType, StockEntryLineInput, CreateStockEntryInput,
  CreateStockEntryResult, SubmitStockEntryResult,
} from './services/stockEntry.js'

export { productValuation } from './services/stock.js'
export * as Valuation from './domain/valuation.js'

export { login, createUser, changePassword, setUserActive } from './services/auth.js'
export type { SessionUser, LoginResult, CreateUserResult, ChangePasswordResult } from './services/auth.js'

export {
  searchProducts, findByBarcode, productsByIds, saleUnitsFor, searchCustomers, listBills, loadBillDetail,
} from './repos/catalog.js'
export type {
  ProductListItem, SearchOptions, SaleUnitOption, CustomerListItem,
  BillListItem, BillDetail, BillDetailItem,
} from './repos/catalog.js'

export { isFirstRun, firstRun, seedDemoData } from './services/seed.js'
export type { FirstRunInput } from './services/seed.js'
export type { Page, Resource, Capability, PermissionSet, RoleTemplate } from './integrity/permissions.js'

export {
  listRegisters, createRegister, renameRegister, setRegisterActive, deleteRegister,
  getDeviceRegister, setDeviceRegister,
} from './services/registers.js'
export type { Register, RegisterResult } from './services/registers.js'

export * as Receipt from './domain/receipt.js'
export type { ReceiptDoc, ReceiptItem, ReceiptShop } from './domain/receipt.js'

export {
  listRoles, loadRoleMatrix, createRole, renameRole, saveRoleMatrix, deleteRole,
  wouldLeaveNoAdministrator,
} from './services/roles.js'
export type { RoleSummary, RoleMatrix, RoleResult, DeleteRoleResult } from './services/roles.js'

export { listStaff, updateUser, resetPassword, unlockUser } from './services/auth.js'
export type { StaffMember } from './services/auth.js'

export * as Reports from './repos/reports.js'
export type { DateRange } from './repos/reports.js'

export { businessDate, addDays } from './dates.js'

export { saveDraft } from './services/billing.js'
export type { SaveDraftResult } from './services/billing.js'
export { listOpenDrafts, loadDraft, discardDraft, pruneEmptyDrafts } from './services/drafts.js'
export type { OpenDraft, DraftDetail, DraftLine } from './services/drafts.js'
export { stockValue, issuedUnitCost } from './services/stock.js'

export * as Backup from './services/backup.js'
export type { BackupFile, BackupPlan } from './services/backup.js'

export {
  listSuppliers, supplierSummaries, createSupplier, updateSupplier, deleteSupplier,
  findOrCreateSupplier, supplierPurchases,
} from './services/suppliers.js'
export type { Supplier, SupplierSummary, SupplierResult, PurchaseLine } from './services/suppliers.js'

export { applyUpgrades } from './services/upgrade.js'
