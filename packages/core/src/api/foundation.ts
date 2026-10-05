/*
 * @shopos/core/foundation -- Money, quantities, ids, dates, the database and the integrity rules everything else stands on.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export * as Money from '../money.js'
export * as Quantity from '../quantity.js'
export { newId, derivedId, timestampOf } from '../ids.js'
export { setDeviceId, setDeviceIdSource, deviceId, setReplacedDevice, replacedDevice } from '../device.js'
export { isStateCode } from '../domain/states.js'
export { GSTIN_SHAPE, isGstin, stateFromGstin, resolveCustomerState } from '../domain/gstin.js'
export { clock, setClock } from '../clock.js'
export type { SqlDriver, Row, SqlValue, ExecResult, TxOptions } from '../db/driver.js'
export { MERGE_BUDGET_MS } from '../db/driver.js'
export { SqlError } from '../db/driver.js'
export { migrate, currentVersion, SchemaTooNewError, SchemaUnversionedError, type Migration } from '../db/migrate.js'
export { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
export {
  MIN_PEER_SCHEMA_VERSION, MIGRATION_FILES, type MigrationKind,
} from '../db/migrationKinds.js'
export { createTauriDriver } from '../db/tauri-driver.js'
export * as DocStatus from '../integrity/docstatus.js'
export * as Permissions from '../integrity/permissions.js'
export { checkLinks, assertDeletable, LinkedRecordError, LINK_RULES } from '../integrity/links.js'
export { writeAudit, diffFields } from '../integrity/audit.js'
export type { AuditAction, AuditContext, AuditRecord, FieldDiff } from '../integrity/audit.js'
export { bootstrap, setSetting, getSetting, forgetSetting } from '../services/bootstrap.js'
export type { BootstrapOptions, BootstrapResult } from '../services/bootstrap.js'
export { nextDocNo, peekDocNo, fiscalYear, fiscalYearTag, docNoFits, MAX_DOC_NO } from '../services/numbering.js'
export type { DocType } from '../services/numbering.js'
export type { Page, Resource, Capability, PermissionSet, RoleTemplate } from '../integrity/permissions.js'
export { HSN_SHAPE, isHsn, hsnProblem, HSN_SHAPE_MESSAGE } from '../domain/hsn.js'
export type { HsnProblem } from '../domain/hsn.js'
export { businessDate, addDays } from '../dates.js'
export { describeSchema } from '../db/describe.js'
export type { SchemaDescription, TableShape, ColumnShape } from '../db/describe.js'
export { renderSchemaDoc } from '../db/schemaDoc.js'
export { parseCsv, parseCsvRecords, toCsv, normaliseHeader } from '../domain/csv.js'
