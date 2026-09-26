/*
 * The pieces, one job each: `sync/types.ts` is the contract between two tills,
 * `sync/round.ts` one round with one peer, `sync/collect.ts` what leaves here,
 * `sync/apply.ts` and `sync/record.ts` what arrives, `sync/review.ts` what a
 * person is asked to look at afterwards, and `sync/peers.ts` who this till
 * knows. Everything is re-exported from here, where callers have always found it.
 */

/**
 * Two tills agreeing.
 *
 * Deliberately knows nothing about networks. It is handed a `SyncTransport` —
 * three methods — and everything that can be got wrong about replication lives
 * on this side of that line, where two real databases can be pointed at each
 * other in a test and made to agree without a socket existing.
 *
 * That split is the point. The bugs that matter here are not dropped packets,
 * they are a row applied on one till and not the other, a cursor moved before
 * the batch arrived, an edit silently overwritten. None of those need a network
 * to happen and none of them need one to reproduce.
 */

export type { ContestedChange, PeerHello, SyncResult, SyncTransport } from './sync/types.js'
export { changedHere, collectChanges } from './sync/collect.js'
export { syncUntilDone, syncWith } from './sync/round.js'
export { isAheadOfUs, noteTillAhead, onTillAhead, type TillAhead } from './sync/versionGap.js'
export { applyBatch } from './sync/apply.js'
export type { MergeOutcome } from './sync/apply.js'
export {
  acknowledgeConflicts, acknowledgeQuarantine, discardQuarantined, quarantinedRecords,
  recentConflicts, unreadConflictCount, unreadQuarantineCount,
} from './sync/review.js'
export type { QuarantinedRecord, RecordedConflict } from './sync/review.js'
export { REPLICATED_TABLES, listPeers, pruneAcknowledged, recordAttempt } from './sync/peers.js'
export type { PeerHealth } from './sync/peers.js'
