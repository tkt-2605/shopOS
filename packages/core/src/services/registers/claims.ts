import { eq, ne, and, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { deviceId } from '../../device.js'
import { tillRole } from '../sync/layout.js'

/*
 * Claims: which till has said it is billing on a counter, and taking one
 * over from a till that has gone.
 */

/** A counter another till is sitting at, and which till that is. */
export interface CounterTaken {
  registerId: string
  /** What that till calls itself, for a sentence naming it. */
  label: string | null
  deviceId: string
  /** When the holder last said so, or null if it never has. See migration 045. */
  at: string | null
  /**
   * True when a screen may offer to take it: unrenewed for long enough, or held
   * by a device id this shop has never met, which is what a restored backup
   * leaves behind. `claims` carries the reasoning.
   */
  stale: boolean
}

/**
 * This machine says it sits at this counter, in the shop's own books.
 *
 * Written to the database rather than only to `device.json`, because the
 * question "is this counter free" is one every till in the shop has to be able
 * to answer, including tills that have never spoken to this one. `registers`
 * replicates, so the claim travels the same way a price does — through a hub,
 * through a till that was switched off when it was made.
 *
 * Which counter *this* machine sits at is still `device.json`'s answer and not
 * this. The two say different things: the file says which counter to bill on,
 * and this says who else must not. A shared row holding "the device's counter"
 * is the bug that migration 019 exists to undo.
 *
 * Claiming releases whatever this machine held before, so a till moved from one
 * counter to another does not leave the first one looking occupied for ever.
 */
export async function claimRegister(
  db: SqlDriver,
  input: { registerId: string; deviceId?: string | null },
): Promise<void> {
  const me = input.deviceId ?? deviceId()
  if (me === null) {
    // Claiming on behalf of a machine that cannot say which machine it is would
    // write a claim nobody can release and that every till reads as somebody.
    throw new Error('This machine does not know which machine it is')
  }
  const now = new Date().toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.registers)
      .set({ claimedBy: null, updatedAt: now })
      .where(and(
        eq(schema.registers.claimedBy, me),
        ne(schema.registers.id, input.registerId),
      ))
    await q(tx).update(schema.registers)
      .set({ claimedBy: me, updatedAt: now })
      .where(eq(schema.registers.id, input.registerId))
  })
}

/**
 * Claims the counter this machine is already billing on, if nobody has.
 *
 * Every till that is selling is sitting at a counter, whether it was asked or
 * fell back to the shop's only one. A till that never says so is a counter the
 * *next* till will be offered as free — so a shop that has run happily on one
 * machine for a year hands its counter to the second one on the day it arrives,
 * which is the original bug wearing a different hat.
 *
 * Only when the counter is unspoken for. A claim by another till is not
 * something to take: `resolveDeviceRegister` refuses that counter, and this
 * machine is asked to pick again rather than quietly overwriting somebody.
 */
export async function claimIfUnclaimed(
  db: SqlDriver,
  registerId: string,
  who: string | null = deviceId(),
): Promise<void> {
  if (who === null) return
  /* Not on a till behind a main: taking a free counter is still taking a
     counter, and that is the main's to grant (`changeCounter`). The main would
     not keep the claim anyway -- see `sync/record.ts`. */
  if (await tillRole(db) === 'till') return
  await q(db).update(schema.registers)
    .set({ claimedBy: who, updatedAt: new Date().toISOString() })
    .where(and(eq(schema.registers.id, registerId), isNull(schema.registers.claimedBy)))
}

/**
 * How long a claim stands without being renewed before a screen will offer it.
 *
 * Three days, which is the shortest span that is certainly not a weekend. A
 * till switched off on Friday evening must still own its counter on Monday
 * morning — the alternative is a shopkeeper arriving to find the front counter
 * offered to the back one and taking it in the ordinary course of saying yes to
 * things.
 *
 * Nothing expires on its own. This is the point at which a *person* is offered
 * the choice, with the till named and the date shown. An automatic release
 * would be two tills billing on one counter at the end of a long weekend, which
 * is the one outcome the claim exists to prevent.
 */
export const CLAIM_GOES_STALE_MS = 3 * 24 * 60 * 60 * 1000

/** Who holds a counter, and whether anybody should still believe it. */
export interface Claim {
  /** The device holding it, or null for a counter nobody has spoken for. */
  deviceId: string | null
  /** What that till calls itself, when this shop has met it. Null for a ghost. */
  label: string | null
  /** When the claim was last renewed. Null means never — see migration 045. */
  at: string | null
  /** True when this machine is the holder. */
  mine: boolean
  /**
   * True when a screen may offer to take it.
   *
   * Either unrenewed for long enough, or held by a device id this shop has
   * never heard of — a restored backup carries the claim of the machine it was
   * taken from, and `device.json` is deliberately not in the backup, so the
   * holder is an identity that does not exist anywhere.
   */
  stale: boolean
}

/**
 * Says so, and renews it.
 *
 * Called at startup by the till that holds the counter, which is what turns
 * `claimed_by` from a lock with no expiry into a statement with a date on it.
 * A claim that is never renewed is one whose holder has stopped starting up,
 * and after 045 a screen can say that in words rather than refusing.
 */
export async function renewClaim(
  db: SqlDriver,
  registerId: string,
  who: string | null = deviceId(),
): Promise<void> {
  if (who === null) return
  await q(db).update(schema.registers)
    .set({ claimedAt: new Date().toISOString() })
    .where(and(eq(schema.registers.id, registerId), eq(schema.registers.claimedBy, who)))
}

/**
 * Who holds each counter, and whether the claim still means anything.
 *
 * The question `Registers.tsx` and `JoinShop.tsx` both had to answer with
 * "claimed" and nothing else, which is right when the holder is the machine in
 * the next aisle and wrong when it is a device id that no longer exists.
 */
export async function claims(db: SqlDriver, now = Date.now()): Promise<Map<string, Claim>> {
  const rows = await q(db)
    .select({
      id: schema.registers.id,
      claimedBy: schema.registers.claimedBy,
      claimedAt: schema.registers.claimedAt,
    })
    .from(schema.registers)

  const peers = await q(db)
    .select({ deviceId: schema.syncPeers.deviceId, label: schema.syncPeers.label })
    .from(schema.syncPeers)
  const known = new Map(peers.map((p) => [p.deviceId, p.label]))

  const me = deviceId()
  /* Only where every till pairs with every other does "never met" mean
     "never existed". A till that syncs through a main has met the main and
     nobody else, so every other till in the shop is a stranger to it -- and
     reading them as ghosts offered a live till's counter, renewed that
     morning, to whoever opened Counters. There, a claim goes stale by its
     date and nothing else. The main has met every till, so it keeps the rule. */
  const strangersAreGhosts = await tillRole(db) !== 'till'
  const held = new Map<string, Claim>()
  for (const row of rows) {
    if (row.claimedBy === null) {
      held.set(row.id, { deviceId: null, label: null, at: null, mine: false, stale: false })
      continue
    }
    const mine = me !== null && row.claimedBy === me
    /* A holder this shop has never paired with and that is not this machine is
       a ghost: the claim came in on a restored backup, and no amount of waiting
       will produce the till that made it. */
    const ghost = strangersAreGhosts && !mine && !known.has(row.claimedBy)
    const age = row.claimedAt === null ? null : now - Date.parse(row.claimedAt)
    held.set(row.id, {
      deviceId: row.claimedBy,
      label: known.get(row.claimedBy) ?? null,
      at: row.claimedAt,
      mine,
      stale: !mine && (ghost || age === null || age > CLAIM_GOES_STALE_MS),
    })
  }
  return held
}

/**
 * Takes a counter whose claim has gone stale.
 *
 * Deliberately separate from `claimIfUnclaimed`, which takes only what nobody
 * has spoken for. This one overrides somebody, so it refuses unless the claim
 * really is stale — a person pressing a button must not be able to take a
 * counter the till beside them is billing on, whatever the screen says.
 */
export type TakeRegisterResult =
  | { ok: true }
  | { ok: false; code: 'STILL_HELD'; label: string | null; at: string | null }

export async function takeRegister(
  db: SqlDriver,
  registerId: string,
  now = Date.now(),
): Promise<TakeRegisterResult> {
  const me = deviceId()
  if (me === null) throw new Error('this machine has no device id')

  const claim = (await claims(db, now)).get(registerId)
  if (claim === undefined) throw new Error('no such register')
  if (claim.mine || claim.deviceId === null) {
    await claimIfUnclaimed(db, registerId, me)
    await renewClaim(db, registerId, me)
    return { ok: true }
  }
  if (!claim.stale) return { ok: false, code: 'STILL_HELD', label: claim.label, at: claim.at }

  await q(db).update(schema.registers)
    .set({ claimedBy: me, claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(schema.registers.id, registerId))
  return { ok: true }
}

/*
 * Which counter a till sits at is the main's to say, and only while it can be
 * asked.
 *
 * A counter is a number series and a drawer, and the only way two machines
 * come to print one bill number is two machines on one counter. Tills apart
 * from each other cannot settle that between themselves -- each holds its own
 * copy of who sits where, and a till switched off for four days wakes up
 * believing the counter it left is still its own. So the claim has one keeper.
 * A till that is not the main asks it, live; when the main cannot be reached
 * nothing changes, and the till goes on billing where it was. And the main
 * does not take a claim from a merge either (`sync/record.ts`), so a till that
 * wrote one by itself -- an old build, or one that woke up on its old counter
 * -- is put right at its next sync instead of overwriting the main's answer.
 *
 * A counter a till makes for itself is not a change of anybody's: its prefix
 * comes from that machine, so it collides with nobody, and it is made and
 * claimed offline as before (`ensureOwnRegister`).
 */

/** What a till asks the main for. */
export interface ClaimAsk {
  registerId: string
  /** Take a counter held by a till that has gone quiet. Refused otherwise. */
  take: boolean
}

/** The main's answer. */
export type ClaimAnswer =
  | { ok: true }
  | { ok: false; code: 'NO_SUCH_COUNTER' | 'COUNTER_OFF' }
  | { ok: false; code: 'STILL_HELD'; label: string | null; at: string | null; stale: boolean }

/** The main's answer, or why there was none. */
export type CounterChange =
  | ClaimAnswer
  | { ok: false; code: 'MAIN_UNREACHABLE'; error: string }

/**
 * The keeper's decision: whether `requester` may sit at this counter, and
 * recording it when it may. Run on the main for a till that asks, and on a
 * till that is the main or has nobody to ask, for itself.
 *
 * Free, or already the requester's: yes. Held by another till: no, unless the
 * request is to take it and the claim has gone stale, by the same test the
 * Counters screen offers it on. Claiming releases whatever the requester held
 * before, so the till that moves does not leave its old counter looking taken.
 */
export async function grantClaim(
  db: SqlDriver,
  requester: string,
  ask: ClaimAsk,
  now = Date.now(),
): Promise<ClaimAnswer> {
  const [row] = await q(db)
    .select({ isActive: schema.registers.isActive })
    .from(schema.registers)
    .where(eq(schema.registers.id, ask.registerId))
  if (row === undefined) return { ok: false, code: 'NO_SUCH_COUNTER' }
  if (row.isActive !== 1) return { ok: false, code: 'COUNTER_OFF' }

  const claim = (await claims(db, now)).get(ask.registerId)
  if (claim !== undefined && claim.deviceId !== null && claim.deviceId !== requester) {
    if (!ask.take || !claim.stale) {
      return { ok: false, code: 'STILL_HELD', label: claim.label, at: claim.at, stale: claim.stale }
    }
  }

  await claimRegister(db, { registerId: ask.registerId, deviceId: requester })
  await renewClaim(db, ask.registerId, requester)
  return { ok: true }
}

/**
 * Changing the counter this machine sits at.
 *
 * On a till behind a main, `askMain` puts the question to the main, and only
 * a yes changes anything. The yes is then written here as well, so this till
 * bills on the counter at once rather than after the next round; the main
 * already holds the same claim, so the merge has nothing to put right. A main,
 * or a till with nobody to ask, decides for itself by the same rule.
 *
 * `askMain` throwing is the main not answering, and nothing is written.
 */
export async function changeCounter(
  db: SqlDriver,
  ask: ClaimAsk,
  askMain: (ask: ClaimAsk) => Promise<ClaimAnswer>,
  now = Date.now(),
): Promise<CounterChange> {
  const me = deviceId()
  if (me === null) throw new Error('this machine has no device id')

  if (await tillRole(db) !== 'till') return grantClaim(db, me, ask, now)

  let answer: ClaimAnswer
  try {
    answer = await askMain(ask)
  } catch (err) {
    return { ok: false, code: 'MAIN_UNREACHABLE', error: err instanceof Error ? err.message : String(err) }
  }
  if (!answer.ok) return answer

  await claimRegister(db, { registerId: ask.registerId, deviceId: me })
  await renewClaim(db, ask.registerId, me)
  return answer
}

/**
 * A till that is not coming back.
 *
 * There was no way to forget a peer anywhere in this codebase, and the cost of
 * that is not tidiness. `pruneAcknowledged` holds the feed at the lowest cursor
 * of *every* peer, so one machine that was sold, stolen or thrown away pins the
 * change feed of every remaining till for the life of the shop — it grows, every
 * round reads more of it, and nothing ever says why.
 *
 * Forgetting takes the row and releases whatever it was holding. The counter it
 * sat at becomes free rather than stale, because this is a person saying that
 * machine is gone, which is better evidence than a date.
 *
 * Not reversible, and it does not need to be: a till that comes back pairs
 * again, which is the same walk to the other machine it took the first time.
 */
export async function forgetPeer(db: SqlDriver, peerDeviceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await q(tx).update(schema.registers)
      .set({ claimedBy: null, claimedAt: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.registers.claimedBy, peerDeviceId))
    await q(tx).delete(schema.syncPeers).where(eq(schema.syncPeers.deviceId, peerDeviceId))
  })
}

/**
 * Counters held by a device id nobody in this shop answers to.
 *
 * What a restore leaves behind. The backup carries `registers.claimed_by` and
 * does not carry `device.json`, so the machine that comes up is a new identity
 * looking at a shop whose counters all belong to a till that no longer exists.
 * It cannot bill — `resolveDeviceRegister` returns null once any peer row
 * exists — and until now it could not take its own counter back either, because
 * every screen refused a claimed one.
 *
 * Offered at the moment the shopkeeper is already answering questions about the
 * restore, rather than discovered on a Saturday.
 */
export async function ghostClaims(db: SqlDriver): Promise<Claim[]> {
  /* A till that syncs through a main has met only the main, so every other
     till in the shop would be listed here -- and freed, every counter in the
     shop, by one press of the button this feeds. Only a till that has met
     every till can say one is a ghost; the main can. See `claims`. */
  if (await tillRole(db) === 'till') return []
  const held = await claims(db)
  const peers = await q(db)
    .select({ deviceId: schema.syncPeers.deviceId })
    .from(schema.syncPeers)
  const known = new Set(peers.map((p) => p.deviceId))
  const me = deviceId()

  return [...held.values()].filter(
    (c) => c.deviceId !== null && c.deviceId !== me && !known.has(c.deviceId),
  )
}

/** Releases every ghost claim, so a restored machine can take its counter. */
export async function clearGhostClaims(db: SqlDriver): Promise<number> {
  const ghosts = await ghostClaims(db)
  if (ghosts.length === 0) return 0
  const now = new Date().toISOString()
  for (const ghost of ghosts) {
    await q(db).update(schema.registers)
      .set({ claimedBy: null, claimedAt: null, updatedAt: now })
      .where(eq(schema.registers.claimedBy, ghost.deviceId!))
  }
  return ghosts.length
}

export class CounterTakenError extends Error {
  readonly code = 'COUNTER_TAKEN'
  constructor() {
    super(
      'Another till has taken this counter, so this one cannot issue bills on it -- '
      + 'two tills on one counter give two customers the same bill number. '
      + 'Open Counters and choose the counter this machine sits at.',
    )
    this.name = 'CounterTakenError'
  }
}

/**
 * Refuses to mint a number on a counter another till now holds.
 *
 * `resolveDeviceRegister` asks the same question, but only when a till loads
 * its counter at start. A claim that moves while a till is running -- another
 * till pressed "Use here" -- was noticed by nobody: the first three-till run
 * had two tills both issuing BTYW4 numbers, kept apart only because the main
 * passed each one's latest number to the other within seconds. With the main
 * off they would have minted the same ones. So it is asked again at the one
 * moment it matters, as the number is taken.
 *
 * A counter nobody has claimed is not a loss: that is every counter in a shop
 * that has only ever had one till.
 */
export async function assertCounterIsMine(db: SqlDriver, registerId: string): Promise<void> {
  const me = deviceId()
  if (me === null) return
  const [row] = await q(db)
    .select({ claimedBy: schema.registers.claimedBy })
    .from(schema.registers)
    .where(eq(schema.registers.id, registerId))
  if (row && row.claimedBy !== null && row.claimedBy !== me) throw new CounterTakenError()
}
