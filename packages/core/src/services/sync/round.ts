import { feedHead } from '../changefeed.js'
import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../../db/migrationKinds.js'
import { deviceId } from '../../device.js'
import { getSetting } from '../settings.js'
import { resolveDeviceRegister } from '../registers.js'
import { clock } from '../../clock.js'
import { applyBatch } from './apply.js'
import { BATCH, changedHere, collectChanges } from './collect.js'
import { rememberPeer } from './peers.js'
import { isAheadOfUs, noteTillAhead } from './versionGap.js'
import { hearMain, mainTill } from './layout.js'
import type { PeerHello, SyncResult, SyncTransport } from './types.js'

/**
 * One round with one peer: pull, apply, push, then move the cursors.
 *
 * Pull before push so that a till which is about to be overruled has already
 * been told about it, and so that a batch we send is built from a database that
 * has just taken in everything the other side had. The order is not arbitrary —
 * doing it the other way round means each till spends a round sending changes
 * the other has already superseded.
 */
export async function syncWith(
  db: SqlDriver,
  transport: SyncTransport,
  chosenRegister?: string | null,
): Promise<SyncResult> {
  const me = deviceId()
  if (me === null) return { ok: false, code: 'NO_IDENTITY' }

  const hello = await transport.hello(await mainTill(db), await feedHead(db))

  /* Before a single row moves.
   *
   * This used to demand that the two versions be equal, which is right while
   * every till in the shop is updated by one person on one afternoon and wrong
   * the first time it is not. An update rolls out; the second till is switched
   * off; it comes back on Monday and the shop cannot sync at all, with nothing
   * on either screen explaining why. That is the common case, and across an
   * additive migration there was never anything unsafe about it.
   *
   * So each side carries a floor -- the version after its last breaking
   * migration -- and the pair is allowed when each is at or above the other's.
   * Both directions are checked because the danger is not symmetrical with the
   * numbers: the newer till writes columns the older has no place for, and the
   * older sends rows missing columns the newer has made NOT NULL. */
  const theirFloor = hello.minPeerSchema ?? hello.schemaVersion
  if (hello.schemaVersion < MIN_PEER_SCHEMA_VERSION) {
    return {
      ok: false, code: 'SCHEMA_MISMATCH', behind: 'theirs',
      mine: EXPECTED_SCHEMA_VERSION, theirs: hello.schemaVersion,
    }
  }
  if (isAheadOfUs(theirFloor)) {
    if (hello.deviceId) noteTillAhead(hello.deviceId, hello.schemaVersion, theirFloor)
    return {
      ok: false, code: 'SCHEMA_MISMATCH', behind: 'mine',
      mine: EXPECTED_SCHEMA_VERSION, theirs: hello.schemaVersion,
    }
  }

  /* Two shops, not two tills. Both databases were set up separately, so each
     minted its own Admin role, its own counter, its own default price list —
     same names, different ids — and every natural key in the schema collides.
     There is no merge rule for that, because the two rows are not two versions
     of one thing; they are two different things with one name. Refused here, at
     the handshake, rather than dying on a UNIQUE constraint halfway through
     writing somebody's database. A till with no shop of its own may join any
     shop, which is exactly what a new till is. */
  const myShop = await getSetting(db, 'shop_id')
  if (myShop !== null && hello.shopId !== null && myShop !== hello.shopId) {
    return { ok: false, code: 'DIFFERENT_SHOP', mine: myShop, theirs: hello.shopId }
  }

  if (hello.deviceId === null) return { ok: false, code: 'NO_IDENTITY' }
  /* A till syncing with itself would apply its own changes back over itself and
     tiebreak every dead heat against its own id. Harmless and completely
     pointless, and it means something is misconfigured, so it is said out loud. */
  if (hello.deviceId === me) return { ok: false, code: 'SAME_DEVICE' }

  /* Both tills billing on one counter. They mint the same invoice numbers from
     the same series, so the first bill to cross fails on `bills.doc_no` and the
     sync dies on a UNIQUE constraint with nothing saying why.

     Refused rather than risked, and refused *before* anything moves.

     This used to be the only thing standing between a shop and duplicate
     invoice numbers, and it stood in the wrong place: a second till was handed
     the first one's counter by default, billed on it happily, and met this
     refusal only afterwards -- with two bills already numbered the same on two
     machines, which pressing "Use here" cannot unmake. `resolveDeviceRegister`
     no longer guesses once a shop has a peer, so a till that has not been told
     which counter it is has none and cannot bill at all.

     Which leaves this as a guard that should never fire, and it stays exactly
     for the cases that are not the default: two machines pointed at one counter
     deliberately, or a choice made on both before they ever met. */
  const mineRegister = await resolveDeviceRegister(db, chosenRegister ?? null)

  /* Which counters are spoken for is not learned here. It used to be -- this
     hello was the only moment one till heard another's counter -- and it was
     late and narrow both: two tills choosing in the same minute have not
     exchanged a hello, and a till behind a hub never exchanges one with its
     sibling at all. The claim lives on the counter now and replicates with it.
     See `claimRegister` and migration 037. */
  if (
    mineRegister !== null
    && hello.registerId !== null
    && hello.registerId !== undefined
    && hello.registerId === mineRegister
  ) {
    return { ok: false, code: 'SAME_REGISTER', registerId: mineRegister }
  }

  const peer = await rememberPeer(db, hello.deviceId, hello.label)
  await recordWhatTheySaid(db, hello)
  /* Who the main is, before anything moves, and whatever the answer the round
     goes on. A peer that turns out to be an old main still holds bills the
     shop needs, and the merge is the same whoever is the main -- what stops
     two mains is that the lower one hears the higher, not that they stop
     talking. See `sync/layout.ts`. */
  await hearMain(db, { device: hello.mainDevice, epoch: hello.mainEpoch })

  // ── pull ────────────────────────────────────────────────────────────────
  const incoming = await transport.fetch(peer.theirCursor, BATCH)
  const mineChanged = await changedHere(db, peer.myCursor, incoming.records)
  const { applied, contested, ignoredColumns, ignoredTables, quarantined, cachesHeld } =
    await applyBatch(db, incoming, mineChanged)

  /* Moved by an empty batch too: one that skipped only this till's own changes,
     relayed back, has still been read up to there (`collectChanges`). */
  if (incoming.records.length > 0 || incoming.upTo > peer.theirCursor) {
    await q(db).update(schema.syncPeers)
      .set({ theirCursor: incoming.upTo })
      .where(eq(schema.syncPeers.deviceId, hello.deviceId))
  }

  // ── push ────────────────────────────────────────────────────────────────
  const outgoing = await collectChanges(db, hello.yourCursorWithThem, BATCH, hello.deviceId)
  let sent = 0
  /* Offered empty when it only moves their cursor past their own changes,
     relayed back: otherwise they never hear it and show this till as short of
     records that are never coming. */
  if (outgoing.records.length > 0 || outgoing.upTo > hello.yourCursorWithThem) {
    const ack = await transport.offer(outgoing)
    /* Their word, not our hope. A batch that left here and never landed has to
       be sent again, and a cursor moved because we posted it is a row lost with
       nothing anywhere recording that it went missing.

       Their word, but not further than we spoke. A peer that answers with a seq
       beyond the batch it was given — a newer build with a different meaning
       for the field, a reply from a round that overtook this one, a peer that is
       simply wrong — would move this cursor past changes it has never been
       offered, and those changes are then never sent to it again by anything.
       Nothing would report it: the screen would say the tills agree. So the
       cursor goes to whichever is smaller, which is the furthest either side can
       honestly claim. */
    const reached = Math.min(ack.upTo, outgoing.upTo)
    /* An upper bound, as it always was — a record already held by the peer is
       counted here and writes nothing there — but no longer a count of rows that
       may never have been offered at all. A peer that moved nothing sent
       nothing, which is what `syncUntilDone` needs to hear to stop. */
    sent = reached > hello.yourCursorWithThem ? outgoing.records.length : 0
    await q(db).update(schema.syncPeers)
      .set({ myCursor: reached })
      .where(eq(schema.syncPeers.deviceId, hello.deviceId))
  }

  await q(db).update(schema.syncPeers)
    .set({ lastAgreedAt: clock.iso() })
    .where(eq(schema.syncPeers.deviceId, hello.deviceId))

  return {
    ok: true,
    peer: hello.deviceId,
    received: applied,
    sent,
    ignoredColumns,
    ignoredTables,
    quarantined,
    cachesHeld,
    contested,
    more: !incoming.complete || !outgoing.complete,
  }
}

/**
 * What the handshake told us about the peer itself, kept.
 *
 * Two things a peer knows about itself that this till can only guess at: how far
 * its own feed goes, and whether anybody can dial it. Both used to be guessed —
 * the first not at all, and the second from whether an address column was set,
 * which gets a phone right by accident and a cloud peer wrong.
 *
 * Only ever narrowing on `reach`. A peer that says it cannot answer is believed,
 * because it is the only thing that knows; a peer that says nothing is left
 * however it was recorded when somebody paired it, because silence from an older
 * build is not a claim.
 */
async function recordWhatTheySaid(db: SqlDriver, hello: PeerHello): Promise<void> {
  const head = Number.isFinite(hello.head) ? Number(hello.head) : null
  const cannotAnswer = hello.answers === false
  /* A round trip's worth of latency is in this and nothing tries to take it
     out. What it is compared against is two and a half minutes; a LAN round
     trip does not move that, and a subtraction that guessed would be a number
     nobody could check. */
  const skew = Number.isFinite(hello.now) ? Math.round(Number(hello.now) - clock.now()) : null

  if (head === null && skew === null && !cannotAnswer) return
  await q(db).update(schema.syncPeers)
    .set({
      /* The date as well as the number, because 0 is an honest answer — a peer
         whose feed has been pruned empty has nothing for us and says so — and
         without the date it is indistinguishable from a peer that has never
         spoken. Those want opposite sentences. Migration 048. */
      ...(head === null ? {} : { theirHead: head, headSaidAt: clock.iso() }),
      ...(skew === null ? {} : { clockSkewMs: skew }),
      ...(cannotAnswer ? { reach: 'none' as const } : {}),
    })
    .where(eq(schema.syncPeers.deviceId, hello.deviceId!))
}

/**
 * Rounds until there is nothing left to say.
 *
 * `syncWith` does one round of at most 200 records and reports `more` when there
 * is a queue behind it. A till switched off for a fortnight has thousands
 * waiting, and one round leaves it almost as far behind as it started — so
 * something has to keep going, and it is here rather than in a screen, where it
 * would be written twice and stopped by a person changing pages.
 *
 * Bounded, because a loop that runs until it is finished is a loop that never
 * finishes if the two tills keep handing each other the same row. `rounds` is
 * reached only when something is wrong, and reaching it is reported rather than
 * retried for ever.
 */
export async function syncUntilDone(
  db: SqlDriver,
  transport: SyncTransport,
  rounds = 50,
  chosenRegister?: string | null,
): Promise<SyncResult> {
  let last = await syncWith(db, transport, chosenRegister)
  let done = 1
  let mark = last.ok ? await cursorsWith(db, last.peer) : ''

  while (last.ok && last.more && done < rounds) {
    const next = await syncWith(db, transport, chosenRegister)
    if (!next.ok) return next

    /* Progress is the cursor moving, not rows landing, and the difference is a
       shop that silently stops catching up.

       `seedFeedWithEverything` runs every time a till joins and puts the whole
       shop back in the feed for *every* peer, which is deliberate. A peer that
       already holds those rows applies none of them — an identical row writes
       nothing, correctly — so a round of two hundred records reports `received: 0`
       and `sent: 0` while being perfectly successful. Read as no progress, that
       stopped the catch-up with hundreds of records still queued behind the
       cursor and told the screen the tills agreed.

       The cursor is the honest measure: it moves when a batch was taken,
       whether or not the batch changed anything. It stays where it is exactly
       when nothing crossed, which is the case this guard is for. */
    const reached = await cursorsWith(db, next.peer)
    if (reached === mark) return { ...next, more: false }
    mark = reached

    last = { ...next, contested: [...last.contested, ...next.contested] }
    done += 1
  }

  return last
}

/** How far the two of us have read into each other, as one comparable thing. */
async function cursorsWith(db: SqlDriver, peer: string): Promise<string> {
  const [row] = await q(db)
    .select({ theirs: schema.syncPeers.theirCursor, mine: schema.syncPeers.myCursor })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, peer))
  return `${row?.theirs ?? 0}/${row?.mine ?? 0}`
}
