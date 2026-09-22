export * as Money from './money.js'
export * as Quantity from './quantity.js'
export { newId, derivedId, timestampOf } from './ids.js'
export { setDeviceId, setDeviceIdSource, deviceId } from './device.js'
export { isStateCode } from './domain/states.js'
export { GSTIN_SHAPE, isGstin, stateFromGstin, resolveCustomerState } from './domain/gstin.js'
export { clock, setClock } from './clock.js'

export type { SqlDriver, Row, SqlValue, ExecResult, TxOptions } from './db/driver.js'
export { MERGE_BUDGET_MS } from './db/driver.js'
export { SqlError } from './db/driver.js'
export { migrate, currentVersion, SchemaTooNewError, SchemaUnversionedError, type Migration } from './db/migrate.js'
export { EXPECTED_SCHEMA_VERSION } from './db/schemaVersion.js'
export {
  MIN_PEER_SCHEMA_VERSION, MIGRATION_FILES, type MigrationKind,
} from './db/migrationKinds.js'
export { createTauriDriver, backupDatabase } from './db/tauri-driver.js'

export * as Tax from './domain/tax.js'
export * as Pricing from './domain/pricing.js'
export * as Loyalty from './domain/loyalty.js'
export * as Credit from './domain/credit.js'
export * as Returns from './domain/returns.js'
export * as DocFormat from './domain/docFormat.js'
export { REPLICATED, NOT_REPLICATED, shapeOf, type RecordShape, type ChangeRecord, type ChangeBatch } from './domain/replicaShape.js'
export { handleSyncRequest, serveAs, setServingRegisterSource, LISTEN_PORT_HEADER, peerAddressFrom, offerPairing, withdrawPairing, pairingOnOffer, expectingAJoin, pendingJoin, onJoinRequest, allowJoin, refuseJoin, PAIRING_WINDOW_MS, type SyncRequest, type SyncResponse, type JoinRequest } from './services/syncServer.js'
export { forgetNonces, CLOCK_TOLERANCE_MS, setFingerprintSource } from './services/syncAuth.js'
export { nextBackoff, BACKOFF_START_MS, BACKOFF_MAX_MS } from './services/syncBackoff.js'
export { httpTransport, pairWith, askToJoin, pollJoin, pairedPeers, rememberAddress, SyncHttpError, type PeerAddress, type PairOutcome, type SelfAddress, type JoinProgress } from './services/syncClient.js'
export { recentConflicts, acknowledgeConflicts, unreadConflictCount, recordAttempt, type RecordedConflict, type PeerHealth } from './services/sync.js'
export {
  quarantinedRecords, unreadQuarantineCount, acknowledgeQuarantine, discardQuarantined,
  type QuarantinedRecord,
} from './services/sync.js'
export { syncWith, syncUntilDone, collectChanges, applyBatch, changedHere, listPeers, pruneAcknowledged, REPLICATED_TABLES, type SyncTransport, type PeerHello, type SyncResult, type ContestedChange } from './services/sync.js'
export { decideRow, decideDeletion, type MergeInput, type MergeDecision, type MergeReason, type Versioned, type Side } from './domain/merge.js'
export * as HtmlTemplate from './domain/htmlTemplate.js'
export type { TemplateProblem } from './domain/htmlTemplate.js'
export type { Block, BlockKind, DocFormat as DocFormatDef, PaperSize, FormatProblem } from './domain/docFormat.js'

export * as DocStatus from './integrity/docstatus.js'
export * as Permissions from './integrity/permissions.js'
export { checkLinks, assertDeletable, LinkedRecordError, LINK_RULES } from './integrity/links.js'
export { writeAudit, diffFields } from './integrity/audit.js'
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
  RULE_46F_THRESHOLD,
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

export { productHistory, productProfit, noCostBasis } from './repos/productHistory.js'
export type { StockMovement, ProductProfit, NoCostBasis } from './repos/productHistory.js'

export { customerProfit, customerItems } from './repos/customerHistory.js'
export type { CustomerProfit, CustomerItem } from './repos/customerHistory.js'

export {
  createReturn, submitReturn, cancelReturn, processReturn, previewReturn, listReturns,
  loadReturnDetail, returnableQty,
} from './services/returns.js'
export type {
  ReturnLineInput, CreateReturnInput, CreateReturnResult, SubmitReturnResult, RefundMethod,
  ProcessReturnResult, PreviewReturnResult, ReturnPreview, ReturnListItem, ReturnOutcome,
  ReturnDetail, ReturnDetailItem,
} from './services/returns.js'

export { loadFeatures, isOn, setFeature, FEATURES_OFF } from './services/features.js'
export { loadStockPolicy, setStockPolicy, STOCK_POLICY_DEFAULT } from './services/features.js'
export type { StockPolicy } from './services/features.js'
export { loadRounding, setRounding, ROUNDING_DEFAULT } from './services/features.js'
export { loadTaxScheme, setTaxScheme, taxSchemeAnswered } from './services/features.js'
export type { Rounding } from './domain/billTotals.js'
export type { Features, FeatureKey } from './services/features.js'

export {
  recordPayment, cancelPayment, customerOutstanding, customerStatement, loadOpenBills,
  totalOutstandingAll,
} from './services/payments.js'
export type {
  RecordPaymentInput, RecordPaymentResult, ReceiptMethod, CustomerStatementRow,
  OutstandingTotal,
} from './services/payments.js'

export {
  getOrOpenSession, openSessionFor, closeSession, sessionSummary, postCashMovement, countDrawer,
  listSessions,
} from './services/cash.js'
export type { ClosedSession } from './services/cash.js'
export type {
  CashMovementInput, OpenSessionInput, SessionSummary, CloseSessionResult, CashDirection, TenderMethod,
} from './services/cash.js'

export { createStockEntry, submitStockEntry, cancelStockEntry, directionOf, signedQty } from './services/stockEntry.js'
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
  countCustomers, listBills, countBills, loadBillDetail, loadCustomer,
} from './repos/catalog.js'
export type {
  BillFilter, BillStatusFilter,
  ProductListItem, SearchOptions, SaleUnitOption, CustomerListItem, CustomerDetail,
  BillListItem, BillDetail, BillDetailItem, CustomerOrder,
} from './repos/catalog.js'

export { isFirstRun, firstRun, seedDemoData } from './services/seed.js'
export type { FirstRunInput } from './services/seed.js'
export type { Page, Resource, Capability, PermissionSet, RoleTemplate } from './integrity/permissions.js'

export {
  listRegisters, createRegister, renameRegister, setRegisterActive,
  renewClaim, claims, takeRegister, forgetPeer, ghostClaims, clearGhostClaims,
  CLAIM_GOES_STALE_MS, type Claim, type TakeRegisterResult,
  resolveDeviceRegister, legacyDeviceRegister, forgetLegacyDeviceRegister,
  countersOtherTillsUse, claimRegister, claimIfUnclaimed,
} from './services/registers.js'
export type { Register, RegisterResult, CounterTaken } from './services/registers.js'

export * as Receipt from './domain/receipt.js'
export type {
  ReceiptDoc, ReceiptItem, ReceiptShop, PreviewLine, DocWording,
  PlaceOfSupply, RateSummaryRow,
} from './domain/receipt.js'
export { BILL_WORDING, formatRate, rateSummaryOf } from './domain/receipt.js'
export {
  TAX_SCHEMES, isTaxScheme, chargesTax, documentTitle, schemeStatement, defaultScheme,
  billWording, COMPOSITION_STATEMENT,
} from './domain/taxScheme.js'
export type { TaxScheme } from './domain/taxScheme.js'
export { setProductActive } from './services/products.js'
export { HSN_SHAPE, isHsn, hsnProblem, HSN_SHAPE_MESSAGE } from './domain/hsn.js'
export type { HsnProblem } from './domain/hsn.js'
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
  archiveCustomer, restoreCustomer,
} from './services/customers.js'
export type { ArchiveCustomerResult } from './services/customers.js'
export type { CustomerInput, CustomerConflict, SaveCustomerResult } from './services/customers.js'
export {
  listCustomerPayments, writeOff, recordOpeningBalance, customerAccount,
  advanceCredit, applyAdvance, refundAdvance,
} from './services/payments.js'
export type {
  CustomerPayment, OpeningBalanceResult,
  CustomerAccount, StatementEntry, StatementKind,
  AdvanceCredit, AdvanceReceipt, ApplyAdvanceResult, RefundAdvanceResult,
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
  archivePriceList, restorePriceList,
  listItemPrices, setItemPrice, removeItemPrice,
  listCustomerPrices, setCustomerPrice, removeCustomerPrice, setCustomerPriceList,
  setLadder, setCustomerLadder, ladderFor, customerLadderFor, laddersFor,
  perBaseUnit,
} from './services/pricing.js'
export type {
  SaleUnit, SaleUnitInput, SetUnitsResult, PriceList, PriceListResult,
  ArchivePriceListResult,
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
  listSuppliers, supplierSummaries, createSupplier, updateSupplier, archiveSupplier, restoreSupplier,
  findOrCreateSupplier, supplierPurchases, supplierItems, setSupplierOpening,
} from './services/suppliers.js'
export type {
  Supplier, SupplierSummary, SupplierResult, PurchaseLine, SupplierItem, OpeningResult,
} from './services/suppliers.js'

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

export {
  TIERS, isTier, GRACE_DAYS, GATED, verifyToken, readTokenUnverified, stateOf,
  allows, overTillLimit, encodePayload, toBase64Url, fromBase64Url,
} from './domain/licence.js'
export type {
  Tier, LicenceToken, LicenceState, GatedFeature, SigningKey,
  VerifyFailure, VerifyResult,
} from './domain/licence.js'

export {
  entitlement, entitled, installToken, removeToken, storedToken, tillOverage,
  witnessClock, UNLICENSED, CLOCK_SLACK_MS,
} from './services/licence.js'
export type { Entitlement, EntitlementOptions, InstallResult } from './services/licence.js'

export {
  canInstall, dueForCheck, updateWords, CHECK_EVERY_MS,
} from './services/update.js'
export type {
  AvailableUpdate, UpdateSource, UpdateStage, CanInstall, InstallRefusal,
} from './services/update.js'

export { describeSchema } from './db/describe.js'
export type { SchemaDescription, TableShape, ColumnShape } from './db/describe.js'
export { renderSchemaDoc } from './db/schemaDoc.js'

export { parseCsv, parseCsvRecords, toCsv, normaliseHeader } from './domain/csv.js'
export {
  planImport, applyImport, exportCatalogue, IMPORT_COLUMNS,
} from './services/import.js'
export type {
  ImportPlan, PlannedRow, ImportResult, ImportAction, RowProblem,
} from './services/import.js'

export {
  planCustomerImport, applyCustomerImport, exportCustomers, CUSTOMER_COLUMNS,
} from './services/customerImport.js'
export type {
  CustomerPlan, PlannedCustomer, CustomerRowProblem, CustomerImportResult,
} from './services/customerImport.js'
