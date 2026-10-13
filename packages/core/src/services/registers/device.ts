import { eq, and, isNotNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { deviceId } from '../../device.js'
import { getSetting, forgetSetting } from '../settings.js'
import { type CounterTaken, claims } from './claims.js'
import { tillRole } from '../sync/layout.js'

/*
 * Which counter this machine bills on, and the ones the other tills use.
 */

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
    /* Behind a main, a counter nobody holds is not one to bill on either: the
       main grants counters (`changeCounter`), and a till that finds its claim
       gone -- put right by the main at a sync -- asks again rather than
       carrying on as if a counter with no keeper were its own. */
    if (live && live.claimedBy === null && await tillRole(db) === 'till') return null
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
