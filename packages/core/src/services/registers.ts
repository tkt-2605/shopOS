import { eq, ne, and, isNull, isNotNull, count, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { deviceId } from '../device.js'
import { writeAudit } from '../integrity/audit.js'
import { getSetting, forgetSetting } from './bootstrap.js'

/**
 * A shop can run several counters. Each gets its own prefix, because that prefix
 * is what keeps two tills billing at the same moment from minting the same
 * invoice number — a globally sequential counter cannot survive a second till.
 */

export interface Register {
  id: string
  name: string
  prefix: string
  isActive: boolean
  hasOpenSession: boolean
}

export async function listRegisters(db: SqlDriver, includeInactive = false): Promise<Register[]> {
  const rows = await q(db)
    .select({
      id: schema.registers.id,
      name: schema.registers.name,
      prefix: schema.registers.prefix,
      isActive: schema.registers.isActive,
      /* A left join and a count rather than a subquery. The join carries "not
         closed" in its own condition: in `where` it would turn the left join
         into an inner one and drop every counter that is not open, which is
         every counter before the shop opens. */
      openSessions: count(schema.cashSessions.id),
    })
    .from(schema.registers)
    .leftJoin(schema.cashSessions, and(
      eq(schema.cashSessions.registerId, schema.registers.id),
      isNull(schema.cashSessions.closedAt),
    ))
    .where(and(...(includeInactive ? [] : [eq(schema.registers.isActive, 1)])))
    .groupBy(schema.registers.id)
    .orderBy(schema.registers.name)

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    isActive: r.isActive === 1,
    hasOpenSession: r.openSessions > 0,
  }))
}

export type RegisterResult =
  | { ok: true; registerId: string }
  | { ok: false; code: 'NAME_TAKEN' }
  | { ok: false; code: 'PREFIX_TAKEN'; prefix: string }
  | { ok: false; code: 'BAD_PREFIX' }

/**
 * Four characters, not six, and the limit is legal rather than aesthetic.
 *
 * A document number is `B` + prefix + `/2627/00001`, and Rule 46(b) caps the
 * whole thing at sixteen. Six characters put it at eighteen. See `numbering.ts`.
 *
 * A register that already has a longer prefix keeps it — it is stamped on every
 * bill printed against it and cannot be rewritten — so this stops new ones
 * rather than repairing old ones.
 */
const PREFIX = /^[A-Z0-9]{2,4}$/

export async function createRegister(
  db: SqlDriver,
  input: { name: string; prefix: string; actorId: string },
): Promise<RegisterResult> {
  const name = input.name.trim()
  const prefix = input.prefix.trim().toUpperCase()

  if (!PREFIX.test(prefix)) return { ok: false, code: 'BAD_PREFIX' }
  if (await exists(db, 'name', name)) return { ok: false, code: 'NAME_TAKEN' }
  if (await exists(db, 'prefix', prefix)) return { ok: false, code: 'PREFIX_TAKEN', prefix }

  const id = newId()
  const now = new Date().toISOString()

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.registers)
      .values({ id, name, prefix, createdAt: now, updatedAt: now })
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'registers', entityId: id, action: 'create', after: { name, prefix },
    })
  })

  return { ok: true, registerId: id }
}

export async function renameRegister(
  db: SqlDriver,
  input: { registerId: string; name: string; actorId: string },
): Promise<RegisterResult> {
  const name = input.name.trim()
  if (await exists(db, 'name', name, input.registerId)) return { ok: false, code: 'NAME_TAKEN' }

  const [before] = await q(db)
    .select({ name: schema.registers.name })
    .from(schema.registers)
    .where(eq(schema.registers.id, input.registerId))

  await db.transaction(async (tx) => {
    await q(tx).update(schema.registers)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(schema.registers.id, input.registerId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'registers', entityId: input.registerId, action: 'update',
      before: { name: before?.name ?? null }, after: { name },
    })
  })
  return { ok: true, registerId: input.registerId }
}

/**
 * The prefix is never editable once bills carry it — changing it would make two
 * different counters share a number series in the history.
 */
export async function setRegisterActive(
  db: SqlDriver,
  input: { registerId: string; isActive: boolean; actorId: string },
): Promise<{ ok: true } | { ok: false; code: 'HAS_OPEN_SESSION' }> {
  if (!input.isActive) {
    const [open] = await q(db)
      .select({ n: count() })
      .from(schema.cashSessions)
      .where(and(
        eq(schema.cashSessions.registerId, input.registerId),
        isNull(schema.cashSessions.closedAt),
      ))
    if ((open?.n ?? 0) > 0) return { ok: false, code: 'HAS_OPEN_SESSION' }
  }

  await db.transaction(async (tx) => {
    await q(tx).update(schema.registers)
      .set({ isActive: input.isActive ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(schema.registers.id, input.registerId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'registers', entityId: input.registerId, action: 'update',
      after: { is_active: input.isActive ? 1 : 0 },
    })
  })
  return { ok: true }
}

/**
 * Which counter this machine bills on, given the choice the machine itself
 * remembers.
 *
 * The choice is **not** stored here, and that is the point. It used to live in
 * `settings` under `device_register_id` — a table the whole shop shares — so two
 * tills on one database would both claim the same counter, overwrite each
 * other's answer, and then mint the same invoice numbers. The comment above this
 * function said it "must never travel with the data when sync arrives" for as
 * long as it did exactly that. It lives in `device.json` beside the database now
 * (`src-tauri/src/device.rs`), which no backup carries and no restore replaces.
 *
 * What stays here is the part that is a question about the database rather than
 * about the machine: whether that counter still exists and is still open for
 * business, and whether falling back to one is safe at all — which, in a shop
 * that has a second till, it is not. See the comment on the fallback.
 */
export async function resolveDeviceRegister(
  db: SqlDriver,
  chosen: string | null,
): Promise<string | null> {
  if (chosen) {
    const [live] = await q(db)
      .select({ id: schema.registers.id, claimedBy: schema.registers.claimedBy })
      .from(schema.registers)
      .where(and(eq(schema.registers.id, chosen), eq(schema.registers.isActive, 1)))

    /* Claimed by somebody else. Two tills that picked this counter while out of
       touch both wrote a claim, the merge settled on one of them, and this is
       the other one finding out. It stops billing rather than carrying on
       alongside the winner — which is the whole point of the claim, and is what
       `bills.doc_no` would otherwise say, later and unrecoverably.

       A null claim is not a loss. It is a counter nobody has spoken for, which
       is every counter in a shop that has only ever had one till. */
    const me = deviceId()
    if (live && live.claimedBy !== null && me !== null && live.claimedBy !== me) return null
    if (live) return live.id
  }

  /* This machine has not been told which counter it is. Falling back to the
     shop's first one is right for a shop that cannot collide with anybody — one
     till, including one that predates the question being asked.

     It is wrong the moment there is a second till, because the shop's first
     counter is the one that till is billing on. This machine would mint that
     counter's invoice numbers, and nothing would say so: the guard is in
     `sync.ts`, which refuses with SAME_REGISTER at the *next sync*, by which
     time both tills hold bills carrying the same number and `bills.doc_no` is
     waiting to fail on whichever crosses first. A state the program will refuse
     to work with is a state it should not hand out.

     So a shop that knows another till gets no guess. Null here means "nobody
     has said", the screens ask, and `App.tsx` keeps this machine off the
     billing screen until somebody answers. */
  const [peer] = await q(db)
    .select({ deviceId: schema.syncPeers.deviceId })
    .from(schema.syncPeers)
    .limit(1)
  if (peer) return null

  const [fallback] = await q(db)
    .select({ id: schema.registers.id })
    .from(schema.registers)
    .where(eq(schema.registers.isActive, 1))
    /* raw: `rowid`, which is not a column and so is not in the schema. The
       order it gives is the order the counters were created in, which is what
       makes the fallback the shop's first counter rather than an arbitrary
       one. */
    .orderBy(sql`rowid`)
    .limit(1)
  return fallback?.id ?? null
}

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
    const ghost = !mine && !known.has(row.claimedBy)
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

/**
 * The prefix of the counter this machine has claimed, or null.
 *
 * The prefix already partitions every document number in the shop
 * (`nextDocNo`), which is the only reason two tills billing at once do not both
 * mint `B/2627/00001`. Anything else a till invents by counting has the same
 * problem and wants the same answer, so the prefix is read from the claim
 * rather than passed down from a screen: a counter this device has claimed is
 * this device's identity as far as the shop is concerned, and it is the same
 * answer whether the caller is billing, naming a customer, or neither.
 *
 * Null for a machine that has claimed nothing — a till that has never been
 * asked which counter it is, which is every single-till shop that predates the
 * question. Callers treat null as "no partition needed", because a shop with
 * one till cannot collide with anybody.
 */
export async function myRegisterPrefix(db: SqlDriver): Promise<string | null> {
  const me = deviceId()
  if (me === null) return null
  const [row] = await q(db)
    .select({ prefix: schema.registers.prefix })
    .from(schema.registers)
    .where(eq(schema.registers.claimedBy, me))
  return row?.prefix ?? null
}

/**
 * The counters this shop's other tills sit at.
 *
 * Read from the counters themselves, so it is as wide as the shop rather than
 * as wide as who this till has spoken to. The first version of this asked the
 * peers table what each till had said in its last `/hello`, which was late —
 * two tills choosing in the same minute have not exchanged one yet, and both
 * saw an empty list — and narrow, because a till behind a hub never hellos its
 * sibling at all.
 *
 * `mine` is left out of the answer: a till is not competing with itself, and a
 * counter this machine has claimed is the one it is supposed to be on.
 */
export async function countersOtherTillsUse(
  db: SqlDriver,
  mine: string | null = deviceId(),
): Promise<CounterTaken[]> {
  const rows = await q(db)
    .select({
      registerId: schema.registers.id,
      claimedBy: schema.registers.claimedBy,
    })
    .from(schema.registers)
    .where(isNotNull(schema.registers.claimedBy))

  const held = rows.filter((r) => r.claimedBy !== mine)
  if (held.length === 0) return []

  /* The till's own name for itself, when this shop has met it. A claim from a
     till this one has never synced with still counts — that is the point of
     keeping it on the counter — and it is named by its id until it has. */
  const peers = await q(db)
    .select({ deviceId: schema.syncPeers.deviceId, label: schema.syncPeers.label })
    .from(schema.syncPeers)
  const nameOf = new Map(peers.map((p) => [p.deviceId, p.label]))

  const standing = await claims(db)

  return held.map((r) => ({
    registerId: r.registerId,
    // The `where` is what makes this true; the column is nullable in the table.
    deviceId: r.claimedBy!,
    label: nameOf.get(r.claimedBy!) ?? null,
    at: standing.get(r.registerId)?.at ?? null,
    stale: standing.get(r.registerId)?.stale ?? false,
  }))
}

const LEGACY_DEVICE_REGISTER = 'device_register_id'

/**
 * The counter a shop already running had chosen, from the shared row it used to
 * be kept in.
 *
 * Reading and forgetting are two functions rather than one on purpose. The value
 * has to reach `device.json` before this row is removed, and that write can
 * fail — see `deviceSettings.ts`. A single take-and-delete looked tidier and
 * lost the answer whenever the file could not be written.
 */
export async function legacyDeviceRegister(db: SqlDriver): Promise<string | null> {
  return getSetting(db, LEGACY_DEVICE_REGISTER)
}

/** Called only once the machine has recorded the counter as its own. */
export async function forgetLegacyDeviceRegister(db: SqlDriver): Promise<void> {
  await forgetSetting(db, LEGACY_DEVICE_REGISTER)
}

async function exists(db: SqlDriver, column: 'name' | 'prefix', value: string, exceptId?: string): Promise<boolean> {
  /* The column was interpolated into the SQL by name. It is picked from the
     table here instead, so a third caller cannot pass a string that is not a
     column of `registers`. */
  const [row] = await q(db)
    .select({ id: schema.registers.id })
    .from(schema.registers)
    .where(and(
      eq(schema.registers[column], value),
      ...(exceptId === undefined ? [] : [ne(schema.registers.id, exceptId)]),
    ))
  return row !== undefined
}
