import { eq, count, min, sql, isNotNull } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { REPLICATED } from '../../domain/replicaShape.js'
import { pendingCount, pruneFeed } from '../changefeed.js'
import { clock } from '../../clock.js'

/*
 * The tills this one knows, how far each pair has read, and whether each one
 * is actually working.
 */

/**
 * Records that a peer could not be reached, or that it now can.
 *
 * One fact per peer rather than a history, because the useful question is "is it
 * working, and since when has it not been" — and a thousand rows saying the same
 * till was off all weekend answer that worse than one row saying so.
 */
export async function recordAttempt(
  db: SqlDriver,
  peerDeviceId: string,
  error: string | null,
): Promise<void> {
  await q(db).update(schema.syncPeers)
    .set({ lastError: error, lastTriedAt: clock.iso() })
    .where(eq(schema.syncPeers.deviceId, peerDeviceId))
}

/* Takes the two fields rather than the whole `hello`, because the device id is
   not optional here although it is on the wire: `syncWith` refuses a peer
   without one before it gets this far, and the column is NOT NULL. */
export async function rememberPeer(
  db: SqlDriver,
  deviceId: string,
  label: string | null,
): Promise<{ theirCursor: number; myCursor: number }> {
  await q(db).insert(schema.syncPeers)
    .values({ deviceId, label, createdAt: clock.iso() })
    .onConflictDoUpdate({
      target: schema.syncPeers.deviceId,
      // The label only. The cursors are where this pair has got to and are
      // never reset by meeting again.
      set: { label },
    })

  const [row] = await q(db)
    .select({
      theirCursor: schema.syncPeers.theirCursor,
      myCursor: schema.syncPeers.myCursor,
    })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, deviceId))
  return { theirCursor: row?.theirCursor ?? 0, myCursor: row?.myCursor ?? 0 }
}

export interface PeerHealth {
  deviceId: string
  label: string | null
  /** When the two tills last actually agreed about everything. */
  lastAgreedAt: string | null
  /** When this till last tried, whether or not it worked. */
  lastTriedAt: string | null
  /** Why the last attempt failed, or null when it did not. */
  lastError: string | null
  /** How much this till still has to tell that one. */
  waiting: number
  /**
   * How much that till has that this one has not seen, or null when it has
   * never said.
   *
   * Null and zero are different answers and a screen must not print them the
   * same way. Zero is "level, as of the last handshake"; null is "this till has
   * never been told", which is a peer on an older build or one never reached.
   *
   * Told apart by `head_said_at` rather than by the number being zero, and that
   * distinction cost a real bug: a peer whose feed has been pruned empty
   * reports a head of 0 quite correctly, so reading 0 as silence made a shop
   * that was completely caught up say it could not tell.
   */
  behind: number | null
  /** What kind of peer it is. See migration 044. */
  reach: string
  /**
   * The shared secret is gone, so nothing can be signed to it or from it.
   * What a till restored from an archive looks like: backups leave the secrets
   * out (`backup.rs`), so every peer has to be paired again.
   */
  needsPairing: boolean
  /**
   * How far that till's clock is from this one, signed: positive means theirs
   * is ahead. Zero is level, or a peer on a build too old to say.
   */
  clockSkewMs: number
}

/**
 * Every till this one knows, and whether it is actually working.
 *
 * `lastAgreedAt` on its own is the number that lies most comfortably: a till
 * that agreed at 4pm and has been unreachable since 4:05 looks, at a glance,
 * exactly like one that agreed at 4pm and had nothing to say afterwards. So the
 * last attempt and its error come with it, and so does how much is queued.
 */
export async function listPeers(db: SqlDriver): Promise<PeerHealth[]> {
  const rows = await q(db)
    .select({
      deviceId: schema.syncPeers.deviceId,
      label: schema.syncPeers.label,
      lastAgreedAt: schema.syncPeers.lastAgreedAt,
      lastTriedAt: schema.syncPeers.lastTriedAt,
      lastError: schema.syncPeers.lastError,
      myCursor: schema.syncPeers.myCursor,
      theirCursor: schema.syncPeers.theirCursor,
      theirHead: schema.syncPeers.theirHead,
      headSaidAt: schema.syncPeers.headSaidAt,
      reach: schema.syncPeers.reach,
      clockSkewMs: schema.syncPeers.clockSkewMs,
      secret: schema.syncPeers.secret,
    })
    .from(schema.syncPeers)
    .orderBy(schema.syncPeers.createdAt)

  /* What a till is called: the counter it sits at, and what it said of itself
     only where it sits at none. Behind a main the counters dial and the main
     is dialled, so the main never hears a counter's own name, and every screen
     on it named the other tills by the first eight characters of a device id.
     And what a till says of itself is the shop's name, which is every till's:
     two tills at one shop each listed the other as the shop (21 October). The
     counter's name is the one the shop chose and can change, on every till
     alike. */
  const seats = await q(db)
    .select({ device: schema.registers.claimedBy, name: schema.registers.name })
    .from(schema.registers)
    .where(isNotNull(schema.registers.claimedBy))
  const counterOf = new Map(seats.map((r) => [r.device, r.name]))

  const out: PeerHealth[] = []
  for (const r of rows) {
    const { myCursor, theirCursor, theirHead, headSaidAt, secret, ...peer } = r
    out.push({
      ...peer,
      label: counterOf.get(peer.deviceId) ?? peer.label ?? null,
      needsPairing: secret === null,
      waiting: await pendingCount(db, myCursor),
      /* Zero, not negative: a head from a handshake that has since been
         overtaken by rows this till pulled would otherwise read as owing
         somebody a negative number of bills. */
      behind: headSaidAt === null ? null : Math.max(0, theirHead - theirCursor),
    })
  }
  return out
}

/**
 * How long a peer can go unheard before it stops holding the feed back.
 *
 * Long enough that a till switched off for a holiday, or a fortnight's repair,
 * is not affected at all. A peer past it is not forgotten -- it keeps its
 * secret and its counter -- it only stops pinning the feed, and if it does come
 * back it is sent the whole shop again. See migration 061.
 */
export const FEED_LEASE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Drops feed entries every peer still in touch has confirmed receiving.
 *
 * The lowest `my_cursor` across those peers, and not a row further: an entry
 * dropped before a till that has been switched off for a fortnight has seen it
 * is a change that machine never learns about. A shop with no peers prunes
 * nothing, which is correct — it has nobody to have told.
 *
 * A peer not heard from within `FEED_LEASE_MS` is left out of the minimum. One
 * phone in a drawer used to pin every till's feed for the life of the shop;
 * now it pins it for a month, and `collectChanges` sends it everything if it
 * returns. With every peer past the lease nothing is pruned: there is nobody
 * left whose progress means anything.
 */
export async function pruneAcknowledged(db: SqlDriver, now = clock.now()): Promise<number> {
  const since = new Date(now - FEED_LEASE_MS).toISOString()
  const [row] = await q(db)
    .select({ safe: min(schema.syncPeers.myCursor), peers: count() })
    .from(schema.syncPeers)
    .where(sql`COALESCE(${schema.syncPeers.lastAgreedAt}, ${schema.syncPeers.createdAt}) >= ${since}`)
  if (!row || row.peers === 0 || row.safe === null) return 0
  return pruneFeed(db, row.safe)
}

/** The tables that travel, for a diagnostic screen and for tests. */
export const REPLICATED_TABLES: readonly string[] = REPLICATED.map((r) => r.table)
