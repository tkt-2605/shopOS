/*
 * @shopos/core/shop -- The shop itself: its profile, staff and roles, counters, features, licence, backups and updates.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export { loadFeatures, isOn, setFeature, FEATURES_OFF } from '../services/features.js'
export { loadStockPolicy, setStockPolicy, STOCK_POLICY_DEFAULT } from '../services/features.js'
export type { StockPolicy } from '../services/features.js'
export { loadRounding, setRounding, ROUNDING_DEFAULT } from '../services/features.js'
export { loadTaxScheme, setTaxScheme, taxSchemeAnswered } from '../services/features.js'
export type { Features, FeatureKey } from '../services/features.js'
export { login, reauthenticate, createUser, changePassword, setUserActive } from '../services/auth.js'
export type {
  SessionUser, LoginResult, ReauthResult, CreateUserResult, ChangePasswordResult,
} from '../services/auth.js'
export { loadShopProfile, saveShopProfile, stateName, STATES } from '../services/shop.js'
export type { ShopProfile, SaveShopResult } from '../services/shop.js'
export { isFirstRun, firstRun, seedDemoData } from '../services/seed.js'
export type { FirstRunInput } from '../services/seed.js'
export {
  listRegisters, createRegister, renameRegister, setRegisterActive,
  renewClaim, claims, takeRegister, forgetPeer, ghostClaims, clearGhostClaims, CounterTakenError,
  CLAIM_GOES_STALE_MS, type Claim, type TakeRegisterResult,
  grantClaim, changeCounter, type ClaimAsk, type ClaimAnswer, type CounterChange,
  resolveDeviceRegister, legacyDeviceRegister, forgetLegacyDeviceRegister,
  countersOtherTillsUse, claimRegister, claimIfUnclaimed, ensureOwnRegister, prefixFor,
} from '../services/registers.js'
export type { Register, RegisterResult, CounterTaken } from '../services/registers.js'
export {
  listRoles, loadRoleMatrix, createRole, renameRole, saveRoleMatrix, deleteRole,
  wouldLeaveNoAdministrator,
} from '../services/roles.js'
export type { RoleSummary, RoleMatrix, RoleResult, DeleteRoleResult } from '../services/roles.js'
export { listStaff, updateUser, resetPassword, unlockUser } from '../services/auth.js'
export type { StaffMember } from '../services/auth.js'
export {
  recoveryCodeState, firstRecoveryCode, makeRecoveryCode, recoverWithCode,
  formatRecoveryCode, normaliseRecoveryCode,
} from '../services/recovery.js'
export type { RecoveryCodeState, RecoverResult } from '../services/recovery.js'
export {
  listAttachments, countAttachments, recordAttachment, removeAttachment,
  attachmentsToCarry, ATTACHMENT_ENTITIES, ACCEPTED_MIME, MAX_BYTES, CARRY_WINDOW_DAYS,
} from '../services/attachments.js'
export type {
  Attachment, AttachmentEntity, StoredFile, AttachInput, CarriedFile, RemovalResult,
} from '../services/attachments.js'
export * as Backup from '../services/backup.js'
export type { BackupFile, BackupPlan, BackupEntry, BackupFormat, BackupKind, BackupSchedule, BackupEvery } from '../services/backup.js'
export { applyUpgrades } from '../services/upgrade.js'
export {
  TIERS, isTier, GRACE_DAYS, GATED, verifyToken, readTokenUnverified, stateOf,
  allows, allowsAny, tierRank, tierFor, overTillLimit, encodePayload, toBase64Url, fromBase64Url,
} from '../domain/licence.js'
export type {
  Tier, LicenceToken, LicenceState, GatedFeature, SigningKey,
  VerifyFailure, VerifyResult,
} from '../domain/licence.js'
export {
  entitlement, entitled, installToken, removeToken, storedToken, storedCodes,
  tillOverage, witnessClock, UNLICENSED, CLOCK_SLACK_MS, useLicenceKeys,
} from '../services/licence.js'
export type {
  Entitlement, EntitlementOptions, InstallResult, Grant,
} from '../services/licence.js'
export { mayTakeMoney, requireMayTakeMoney, ViewOnlyTillError } from '../services/extraCounters.js'
export {
  canInstall, dueForCheck, updateWords, CHECK_EVERY_MS,
} from '../services/update.js'
export type {
  AvailableUpdate, UpdateSource, UpdateStage, CanInstall, InstallRefusal,
} from '../services/update.js'
export { releaseDecision, readTarget, shortShopId } from '../domain/updateTarget.js'
export { noteDataForSupport } from '../services/support.js'
export { checkPack, applyPack, type PackCheck, type ApplyResult, type RepairPreview } from '../services/repair.js'
export { verifyPack, readPackUnverified, type Pack, type Repair, type PackFailure } from '../domain/repairPack.js'
export { REPAIR_KEYS } from '../config/repairs.js'
export type { ReleaseTarget, ReleaseDecision } from '../domain/updateTarget.js'
export { shopProgress, setupHidden, hideSetup } from '../services/setup.js'
export type { ShopStep, ShopProgress } from '../services/setup.js'
/* Everything in the records that does not add up, for a person to see. */
export { findDiscrepancies, discrepanciesWithSeen, markDiscrepanciesSeen, applyRemedy, type RemedyResult } from '../services/discrepancies.js'
export type { Discrepancy, DiscrepancyKind, Remedy } from '../services/discrepancies.js'
