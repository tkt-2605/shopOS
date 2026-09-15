export * as Money from './money.js'
export * as Quantity from './quantity.js'
export { newId, timestampOf } from './ids.js'
export { setDeviceId, setDeviceIdSource, deviceId } from './device.js'
export { clock, setClock } from './clock.js'

export type { SqlDriver, Row, SqlValue, ExecResult } from './db/driver.js'
export { SqlError } from './db/driver.js'
export { migrate, currentVersion, SchemaTooNewError, SchemaUnversionedError, type Migration } from './db/migrate.js'
export { EXPECTED_SCHEMA_VERSION } from './db/schemaVersion.js'
export { createTauriDriver, backupDatabase } from './db/tauri-driver.js'

export * as Tax from './domain/tax.js'
export * as Pricing from './domain/pricing.js'
export * as Loyalty from './domain/loyalty.js'
export * as Credit from './domain/credit.js'
export * as Returns from './domain/returns.js'
export * as DocFormat from './domain/docFormat.js'
export { REPLICATED, NOT_REPLICATED, shapeOf, type RecordShape, type ChangeRecord, type ChangeBatch } from './domain/replicaShape.js'
export { handleSyncRequest, serveAs, setServingRegisterSource, LISTEN_PORT_HEADER, peerAddressFrom, offerPairing, withdrawPairing, pairingOnOffer, PAIRING_WINDOW_MS, type SyncRequest, type SyncResponse } from './services/syncServer.js'
export { forgetNonces, CLOCK_TOLERANCE_MS } from './services/syncAuth.js'
export { nextBackoff, BACKOFF_START_MS, BACKOFF_MAX_MS } from './services/syncBackoff.js'
export { httpTransport, pairWith, pairedPeers, rememberAddress, SyncHttpError, type PeerAddress, type PairOutcome, type SelfAddress } from './services/syncClient.js'
export { recentConflicts, acknowledgeConflicts, unreadConflictCount, recordAttempt, type RecordedConflict, type PeerHealth } from './services/sync.js'
export { syncWith, syncUntilDone, collectChanges, applyBatch, changedHere, listPeers, pruneAcknowledged, REPLICATED_TABLES, type SyncTransport, type PeerHello, type SyncResult, type ContestedChange } from './services/sync.js'
export { decideRow, decideDeletion, type MergeInput, type MergeDecision, type MergeReason, type Versioned, type Side } from './domain/merge.js'
export * as HtmlTemplate from './domain/htmlTemplate.js'
export type { TemplateProblem } from './domain/htmlTemplate.js'
export type { Block, BlockKind, DocFormat as DocFormatDef, PaperSize, FormatProblem } from './domain/docFormat.js'

export * as DocStatus from './integrity/docstatus.js'
export * as Permissions from './integrity/permissions.js'
export { checkLinks, assertDeletable, LinkedRecordError, LINK_RULES } from './integrity/links.js'
export { writeAudit, writeActivity, diffFields } from './integrity/audit.js'
export type { AuditAction, AuditContext, AuditRecord, FieldDiff } from './integrity/audit.js'

export { bootstrap, setSetting, getSetting, forgetSetting } from './services/bootstrap.js'
export { moveSettingsToDevice, type DeviceStore, type MoveResult } from './services/deviceSettings.js'
export {
  changesSince, feedHead, pendingCount, applyingRemote, isApplyingRemote,
  resetSyncState, pruneFeed, seedFeedWithEverything, type Change, type ChangeOp,
} from './services/changefeed.js'
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

export { nextDocNo, peekDocNo, fiscalYear, fiscalYearTag, docNoFits, MAX_DOC_NO } from './services/numbering.js'
export type { DocType } from './services/numbering.js'

export { loadPriceCandidates, defaultPriceListId, resolveSaleUnit } from './repos/pricing.js'

export {
  createReturn, submitReturn, cancelReturn, processReturn, previewReturn, listReturns, returnableQty,
} from './services/returns.js'
export type {
  ReturnLineInput, CreateReturnInput, CreateReturnResult, SubmitReturnResult, RefundMethod,
  ProcessReturnResult, PreviewReturnResult, ReturnPreview, ReturnListItem, ReturnOutcome,
} from './services/returns.js'

export { loadFeatures, isOn, setFeature, FEATURES_OFF } from './services/features.js'
export { loadStockPolicy, setStockPolicy, STOCK_POLICY_DEFAULT } from './services/features.js'
export type { StockPolicy } from './services/features.js'
export { loadRounding, setRounding, ROUNDING_DEFAULT } from './services/features.js'
export type { Rounding } from './domain/billTotals.js'
export type { Features, FeatureKey } from './services/features.js'

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

export { login, reauthenticate, createUser, changePassword, setUserActive } from './services/auth.js'
export type {
  SessionUser, LoginResult, ReauthResult, CreateUserResult, ChangePasswordResult,
} from './services/auth.js'

export { loadShopProfile, saveShopProfile, stateName, STATES } from './services/shop.js'
export type { ShopProfile, SaveShopResult } from './services/shop.js'

export {
  listFormats, loadFormat, formatFor, saveFormat, deleteFormat, chooseFormat, chosenFormatId,
} from './services/formats.js'
export type {
  StoredFormat, FormatInput, SaveFormatResult, DeleteFormatResult, ChooseResult,
} from './services/formats.js'

export {
  searchProducts, findByBarcode, productsByIds, saleUnitsFor, searchCustomers,
  listBills, countBills, loadBillDetail,
} from './repos/catalog.js'
export type {
  BillFilter, BillStatusFilter,
  ProductListItem, SearchOptions, SaleUnitOption, CustomerListItem,
  BillListItem, BillDetail, BillDetailItem,
} from './repos/catalog.js'

export { isFirstRun, firstRun, seedDemoData } from './services/seed.js'
export type { FirstRunInput } from './services/seed.js'
export type { Page, Resource, Capability, PermissionSet, RoleTemplate } from './integrity/permissions.js'

export {
  listRegisters, createRegister, renameRegister, setRegisterActive, deleteRegister,
  resolveDeviceRegister, legacyDeviceRegister, forgetLegacyDeviceRegister,
} from './services/registers.js'
export type { Register, RegisterResult } from './services/registers.js'

export * as Receipt from './domain/receipt.js'
export type { ReceiptDoc, ReceiptItem, ReceiptShop, PreviewLine, DocWording } from './domain/receipt.js'
export { BILL_WORDING } from './domain/receipt.js'
export { buildInvoiceHtml } from './domain/invoiceHtml.js'
export type { InvoiceHtmlOptions } from './domain/invoiceHtml.js'

export {
  listRoles, loadRoleMatrix, createRole, renameRole, saveRoleMatrix, deleteRole,
  wouldLeaveNoAdministrator,
} from './services/roles.js'
export type { RoleSummary, RoleMatrix, RoleResult, DeleteRoleResult } from './services/roles.js'

export { listStaff, updateUser, resetPassword, unlockUser } from './services/auth.js'
export type { StaffMember } from './services/auth.js'

export { listAuditEntries, auditEntities, auditActors, countAuditEntries } from './repos/audit.js'
export type { AuditEntry, AuditFilter, FieldChange } from './repos/audit.js'

export * as Reports from './repos/reports.js'

export { reorderList, bySupplier } from './repos/reorder.js'
export type { ReorderRow, ReorderOptions, SupplierGroup } from './repos/reorder.js'
export { listShortfalls, countShortfalls } from './repos/shortfalls.js'
export {
  createCustomer, updateCustomer, customerByPhone, nextCustomerCode, backfillCustomerCodes,
} from './services/customers.js'
export type { CustomerInput, CustomerConflict, SaveCustomerResult } from './services/customers.js'
export {
  listCustomerPayments, writeOff, recordOpeningBalance, customerAccount,
} from './services/payments.js'
export type {
  CustomerPayment, OpeningBalanceResult,
  CustomerAccount, StatementEntry, StatementKind,
} from './services/payments.js'
export type { Shortfall, ShortfallSummary } from './repos/shortfalls.js'
export type { DateRange } from './repos/reports.js'

export { businessDate, addDays } from './dates.js'

export { saveDraft } from './services/billing.js'
export type { SaveDraftResult } from './services/billing.js'
export { listOpenDrafts, loadDraft, discardDraft, pruneEmptyDrafts } from './services/drafts.js'
export type { OpenDraft, DraftDetail, DraftLine } from './services/drafts.js'
export {
  listUnits, setUnits, listPriceLists, createPriceList, updatePriceList,
  listItemPrices, setItemPrice, removeItemPrice,
  listCustomerPrices, setCustomerPrice, removeCustomerPrice, setCustomerPriceList,
  setLadder, setCustomerLadder, ladderFor, customerLadderFor, laddersFor,
  perBaseUnit,
} from './services/pricing.js'
export type {
  SaleUnit, SaleUnitInput, SetUnitsResult, PriceList, PriceListResult,
  ItemPrice, ItemPriceInput, ItemPriceResult, CustomerPrice, SetLadderResult,
} from './services/pricing.js'

export * as Ladder from './domain/ladder.js'
export type { Rung, LadderRow, RowsResult } from './domain/ladder.js'

export {
  listCategories, createCategory, renameCategory, removeCategory, setProductCategory,
  setVariantOf, variantFamily,
} from './services/grouping.js'
export type { Category, CategoryResult, VariantMember, VariantResult } from './services/grouping.js'

export { listBarcodes, setBarcodes, productIdForBarcode } from './services/barcodes.js'
export type { Barcode, BarcodeInput, SetBarcodesResult } from './services/barcodes.js'

export { stockValue, issuedUnitCost } from './services/stock.js'

export {
  openCount, loadCount, listCounts, openSheet, setCounted, submitCount, cancelCount,
} from './services/stockCount.js'
export type {
  CountScope, OpenCountInput, OpenCountResult, CountLine, CountSheet,
  CountSummary, SubmitCountResult, MovedLine,
} from './services/stockCount.js'

export {
  listAttachments, countAttachments, recordAttachment, removeAttachment,
  attachmentsToCarry, ATTACHMENT_ENTITIES, ACCEPTED_MIME, MAX_BYTES, CARRY_WINDOW_DAYS,
} from './services/attachments.js'
export type {
  Attachment, AttachmentEntity, StoredFile, AttachInput, CarriedFile, RemovalResult,
} from './services/attachments.js'

export * as Backup from './services/backup.js'
export type { BackupFile, BackupPlan, BackupEntry, BackupFormat, BackupKind } from './services/backup.js'

export {
  listSuppliers, supplierSummaries, createSupplier, updateSupplier, deleteSupplier,
  findOrCreateSupplier, supplierPurchases,
} from './services/suppliers.js'
export type { Supplier, SupplierSummary, SupplierResult, PurchaseLine } from './services/suppliers.js'

export {
  createDocument, submitDocument, cancelDocument, listDocuments, loadDocument,
} from './services/documents.js'
export type {
  DocumentKind, DocumentLineInput, CreateDocumentInput, CreateDocumentResult,
  SubmitDocumentResult, CancelDocumentResult,
  DocumentListItem, DocumentFilter, DocumentDetail, DocumentItemRow, DocumentStatus,
} from './services/documents.js'

export { quotationToSalesOrder, receivePurchaseOrder, documentToCart } from './services/convert.js'
export type { ConvertResult, ReceiveResult, ToCartResult, OrderCartLine } from './services/convert.js'

export { applyUpgrades } from './services/upgrade.js'

export * as Totals from './domain/billTotals.js'
export type { ComputedTotals, LineTotals, TotalsLine } from './domain/billTotals.js'
export { pricingContextFor, resolveLinePrice } from './repos/pricing.js'
export type { BillPricingContext } from './repos/pricing.js'
