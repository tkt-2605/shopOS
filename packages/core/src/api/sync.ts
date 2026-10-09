/*
 * @shopos/core/sync -- Tills talking to each other: the change feed, the merge, pairing and the wire.
 *
 * One of the areas core is published in (`package.json` exports). A caller
 * that needs only this area imports it here; `@shopos/core` is every area at
 * once and stays for the callers that want that. Re-exports only: nothing is
 * defined in a barrel (`architecture.test.ts`).
 */

export { REPLICATED, NOT_REPLICATED, shapeOf, type RecordShape, type ChangeRecord, type ChangeBatch } from '../domain/replicaShape.js'
export { handleSyncRequest, serveAs, setServingRegisterSource, LISTEN_PORT_HEADER, peerAddressFrom, offerPairing, withdrawPairing, pairingOnOffer, expectingAJoin, pendingJoin, onJoinRequest, allowJoin, refuseJoin, PAIRING_WINDOW_MS, type SyncRequest, type SyncResponse, type JoinRequest } from '../services/syncServer.js'
export {
  forgetNonces, CLOCK_TOLERANCE_MS, setFingerprintSource, pairingKey, comparisonDigits, codeProof, codeConfirmation, keyCommitment,
} from '../services/syncAuth.js'
export { nextBackoff, BACKOFF_START_MS, BACKOFF_MAX_MS } from '../services/syncBackoff.js'
export { httpTransport, pairWith, askToJoin, pollJoin, pairedPeers, rememberAddress, SyncHttpError, joinByCopy, requestCopy, type PeerAddress, type PairOutcome, type SelfAddress, type JoinProgress } from '../services/syncClient.js'
export { recentConflicts, acknowledgeConflicts, unreadConflictCount, recordAttempt, type RecordedConflict, type PeerHealth } from '../services/sync.js'
export {
  quarantinedRecords, unreadQuarantineCount, acknowledgeQuarantine, discardQuarantined,
  type QuarantinedRecord,
} from '../services/sync.js'
export { onTillAhead, isAheadOfUs, type TillAhead } from '../services/sync.js'
export { adoptRestoredIdentity, type Adopted } from '../services/sync.js'
export {
  takeCopy, wouldLoseWork, type CopyHost, type CopyMaker, type CopyPlan, type CopyRefusal, type ShopCopy,
} from '../services/sync.js'
export {
  handTheMainTo, keepTillsEqual, listens, mainTill, makeThisTheMain, tillRole, type MainTill, type Role,
} from '../services/sync.js'
export { NeedsTls, assertSafeToSpeak, onThisNetwork } from '../services/sync/reach.js'
export { syncWith, syncUntilDone, collectChanges, applyBatch, changedHere, listPeers, pruneAcknowledged, REPLICATED_TABLES, type SyncTransport, type PeerHello, type SyncResult, type ContestedChange } from '../services/sync.js'
export { decideRow, decideDeletion, type MergeInput, type MergeDecision, type MergeReason, type Versioned, type Side } from '../domain/merge.js'
export { moveSettingsToDevice, type DeviceStore, type MoveResult } from '../services/deviceSettings.js'
export {
  changesSince, feedHead, pendingCount, applyingRemote, isApplyingRemote,
  resetSyncState, pruneFeed, seedFeedWithEverything, type Change, type ChangeOp,
} from '../services/changefeed.js'
