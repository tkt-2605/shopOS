import type { ChangeBatch } from '../../domain/replicaShape.js'

/*
 * What two tills say to each other, and what a round reports back.
 *
 * Types only: the handshake, the three-method transport, and the answer. Kept
 * apart so the HTTP client and server can speak them without importing the
 * merge that acts on them.
 */

export interface PeerHello {
  deviceId: string | null
  label: string | null
  schemaVersion: number
  /**
   * The oldest schema the peer will sync with.
   *
   * Optional, and its absence means something specific rather than nothing: a
   * till running a build from before Phase 2c does not send this field *and*
   * refuses anything but an exact match. Treating "absent" as "they demand
   * equality" is therefore the truth about that peer, not a guess -- and it
   * gives the honest refusal here instead of a round that dies at their end.
   */
  minPeerSchema?: number
  /**
   * Which shop the peer is. Null on a till that has been migrated and not set
   * up, which is what a new till joining an existing shop looks like.
   */
  shopId: string | null
  /**
   * Which counter the peer bills on. Two tills on one counter mint the same
   * invoice numbers, which is the one thing the whole seam exists to prevent.
   */
  registerId?: string | null
  /** How far the peer has read of *our* feed. */
  yourCursorWithThem: number
  /**
   * How far *their* feed goes.
   *
   * The other half of the pair above, and the one that was missing. With only
   * `yourCursorWithThem` a till can say what it still owes and cannot say what
   * it is owed — so a screen reads "everything sent" while this machine is
   * ninety-five bills short and every total on every report is short with it.
   *
   * Optional, because a till on a build from before 044 does not send one.
   * Absent reads as "cannot say", which is not the same as level and is why
   * `behind` is null rather than zero in that case.
   */
  head?: number
  /**
   * Whether this peer can be dialled at all.
   *
   * The peer stating its own shape, rather than this till inferring it from
   * whether an address column happens to be set. A phone answers `false` — iOS
   * suspends a backgrounded app, so there is no port and there never will be —
   * and a till that knows that stops waiting for a timeout every round and
   * stops reporting the shop as unreachable. See migration 044.
   *
   * Absent means yes, which is what every till before 044 is.
   */
  answers?: boolean
  /**
   * The answering till's own clock, in milliseconds.
   *
   * `verify` refuses a request more than five minutes out and that wall is the
   * right wall, but it arrives all at once: a till that has been off and came
   * back with a flat battery fails every round from the first, having drifted
   * through four minutes with nothing said. And the wall is not even the worst
   * of it — the merge settles a tie on `updated_at`, so two tills three minutes
   * apart are two tills where the slower one quietly loses edits it made later,
   * with both screens saying everything agrees.
   *
   * Absent on a build from before 046, which records as level.
   */
  now?: number
  /**
   * Which till the peer believes is the main, and at which epoch. See
   * `sync/layout.ts` and migration 071.
   *
   * Sent in both directions -- the asking till puts its own in the body of
   * `/hello` -- because the till that most needs to hear a higher epoch is an
   * old main that came back, and nobody dials a main: it hears it from the
   * till that asks it something.
   *
   * Absent on a build from before 071, and on a shop with no main. Silence is
   * not a claim and changes nothing.
   */
  mainDevice?: string | null
  mainEpoch?: number
}

export interface SyncTransport {
  /**
   * Who are you, what version are you on, and how far have you read of mine?
   *
   * Told who this till believes the main is, so the far side can follow a
   * higher epoch. A transport that does not pass it on loses nothing but that.
   */
  /**
   * `head` is how far this till's own feed goes, said so the answering till
   * can tell how much it is owed: behind one main the counters do all the
   * asking, and the main had no other way to learn it.
   */
  hello(main?: { device: string | null; epoch: number }, head?: number): Promise<PeerHello>
  /** Everything you have after `since`, up to `limit` records. */
  fetch(since: number, limit: number): Promise<ChangeBatch>
  /** Here is everything I have after your cursor. */
  offer(batch: ChangeBatch): Promise<{ upTo: number }>
}

export type SyncResult =
  | {
      ok: true
      peer: string
      received: number
      sent: number
      /** Rows where both tills had changed the same record since last agreeing. */
      contested: ContestedChange[]
      /** True when more is waiting and another round would fetch it. */
      more: boolean
      /**
       * Columns and tables in what arrived that this database has no place for.
       *
       * Not an error and not silence. A till one additive migration ahead sends
       * rows with a column this one has never heard of; dropping it is right,
       * and saying nothing about it would leave a shopkeeper with two tills
       * that quietly hold different things. The newer side reports zero and the
       * older side reports what it left out, so the counts also say which way
       * round the pair is.
       */
      ignoredColumns: number
      ignoredTables: number
      /**
       * Records that arrived and could not be applied, set aside rather than
       * allowed to stop everything behind them. See migration 038.
       *
       * Non-zero is not a failed round -- the rest of the batch landed and the
       * cursor moved. It is a round that dropped something, which is a different
       * thing from a round that stalled, and a shopkeeper is owed both.
       */
      quarantined: number
      /** See `MergeOutcome.cachesHeld`. */
      cachesHeld: number
    }
  | {
      ok: false; code: 'SCHEMA_MISMATCH'; mine: number; theirs: number
      /** Which side is too old to be talked to, for the sentence a screen shows. */
      behind: 'mine' | 'theirs'
    }
  | { ok: false; code: 'NO_IDENTITY' }
  | { ok: false; code: 'SAME_DEVICE' }
  | { ok: false; code: 'DIFFERENT_SHOP'; mine: string; theirs: string }
  | { ok: false; code: 'SAME_REGISTER'; registerId: string }

export interface ContestedChange {
  table: string
  rowId: string
  winner: 'mine' | 'theirs'
  explain: string
}
