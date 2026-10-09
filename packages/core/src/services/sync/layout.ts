import { eq, isNotNull } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { deviceId } from '../../device.js'
import { requirePermission } from '../../integrity/permissions.js'

/*
 * Who this till talks to: whether it is the main, whether it listens, and
 * whether it may let another till in.
 *
 * Every till used to be the equal of every other, and the answers to these
 * questions were spread over the sync loop, the listener and pairing, each
 * deciding for itself. `docs/specs/one-main-till.md` replaced the equality
 * with one main per shop, and this file is the one place that knows what that
 * means. Nothing here moves a row: the merge, the feed and the cursors are the
 * same whoever is the main.
 *
 * Two facts decide everything, and both were already true before the main
 * existed:
 *
 * - **A till that does not listen is never given an address.** Pairing records
 *   the port a till says it answers on, and a till that answers on none is a
 *   peer the other side cannot dial. So a main dials nobody -- its tills have
 *   no address -- and a till dials only the peers it holds an address for,
 *   which in a shop with a main is the main. `pairedPeers` needed no change.
 * - **Every till holds the whole books and merges both ways.** So exchanging
 *   rows with a till that is no longer the main is never wrong. What makes two
 *   mains dangerous is two groups of tills that never meet, and the epoch is
 *   what stops that: the main that hears a higher one steps down, and becomes a
 *   till of the main it heard.
 */

/**
 * - `alone`: no peers, and no main recorded. Most shops.
 * - `main`: the till the others join and dial.
 * - `till`: syncs through the main.
 * - `equals`: paired before there was a main. Behaves as every till did then,
 *   until somebody makes one of them the main.
 */
export type Role = 'alone' | 'main' | 'till' | 'equals'

export interface MainTill {
  /** The main's device id, or null in a shop that has none. */
  device: string | null
  /** Raised by one at every change of main. Zero before there was one. */
  epoch: number
}

export async function mainTill(db: SqlDriver): Promise<MainTill> {
  const [row] = await q(db)
    .select({ device: schema.syncState.mainDevice, epoch: schema.syncState.mainEpoch })
    .from(schema.syncState)
    .where(eq(schema.syncState.id, 1))
  return { device: row?.device ?? null, epoch: row?.epoch ?? 0 }
}

async function writeMain(db: SqlDriver, main: MainTill): Promise<void> {
  await q(db).update(schema.syncState)
    .set({ mainDevice: main.device, mainEpoch: main.epoch })
    .where(eq(schema.syncState.id, 1))
}

/** The peers this till shares a secret with, and whether it can dial each. */
async function peersWithSecrets(db: SqlDriver): Promise<Array<{ deviceId: string; address: string | null }>> {
  return q(db)
    .select({ deviceId: schema.syncPeers.deviceId, address: schema.syncPeers.address })
    .from(schema.syncPeers)
    .where(isNotNull(schema.syncPeers.secret))
}

export async function tillRole(db: SqlDriver): Promise<Role> {
  const main = await mainTill(db)
  if (main.device === null) {
    const [row] = await q(db).select({ id: schema.syncPeers.deviceId }).from(schema.syncPeers).limit(1)
    return row === undefined ? 'alone' : 'equals'
  }
  return main.device === deviceId() ? 'main' : 'till'
}

/**
 * Whether this till should hold a port open.
 *
 * The main does, as soon as it has a till. A till does not -- it dials -- with
 * one exception that keeps a handover from stranding anybody: a till that
 * other tills still dial goes on answering them. That is a main that has just
 * handed over, relaying for the tills that have not yet paired with the new
 * one, and the hub test (`aHubInTheMiddle.test.ts`) is why relaying is safe.
 *
 * Tills paired before there was a main listen as they always did.
 */
export async function listens(db: SqlDriver): Promise<boolean> {
  const peers = await peersWithSecrets(db)
  if (peers.length === 0) return false
  if (await tillRole(db) !== 'till') return true
  return peers.some((p) => p.address === null)
}

export type LetIn = { ok: true } | { ok: false; main: string }

/**
 * Whether a till asking to join may be heard here.
 *
 * Only the main lets tills in, and a till that is alone may, because letting
 * the first one in is what makes it the main. A till refuses and names the
 * main, so the screen on the asking side can say where to go instead.
 */
export async function mayLetIn(db: SqlDriver): Promise<LetIn> {
  const main = await mainTill(db)
  if (main.device === null || main.device === deviceId()) return { ok: true }
  return { ok: false, main: main.device }
}

/**
 * Whether a till that lets another in becomes the main. True in every shop.
 *
 * False only on the bench, which proves the protocol rather than the product:
 * the acceptance criterion is N tills converging over *any* connection graph
 * -- a line, a ring, a mesh -- and a shop's star is one graph among those. The
 * bench builds its graphs through the real pairing route, so it switches the
 * main off for the whole process rather than reaching into `sync_state`.
 */
let mainOnFirstJoin = true

export function keepTillsEqual(equal = true): void {
  mainOnFirstJoin = !equal
}

/**
 * The first till let in makes this one the main.
 *
 * Only from `alone`. A shop paired before there was a main stays as it was --
 * nobody chose a main there, and choosing one for them on the strength of who
 * happened to add the next till would be a guess -- until somebody presses
 * "Make this the main till".
 */
export async function becomeMainIfAlone(db: SqlDriver): Promise<MainTill> {
  const main = await mainTill(db)
  if (main.device !== null || !mainOnFirstJoin) return main
  if (await tillRole(db) !== 'alone') return main
  const me = deviceId()
  if (me === null) return main
  const next = { device: me, epoch: main.epoch + 1 }
  await writeMain(db, next)
  return next
}

/**
 * Something another till said about who the main is.
 *
 * The highest epoch wins. Two mains at the same epoch -- two people pressing
 * "Make this the main till" on two machines that could not see each other --
 * are settled by the lower device id, which both sides work out the same way
 * without asking anybody. Silence, from a build that predates the main, is
 * not a claim and changes nothing.
 *
 * Returns whether this till's idea of the main changed, which is what tells
 * the loop to open or close the door.
 */
export async function hearMain(
  db: SqlDriver,
  said: { device?: unknown; epoch?: unknown } | null | undefined,
): Promise<boolean> {
  const device = typeof said?.device === 'string' && said.device !== '' ? said.device : null
  const epoch = typeof said?.epoch === 'number' && Number.isInteger(said.epoch) ? said.epoch : 0
  if (device === null || epoch < 1) return false

  const mine = await mainTill(db)
  const higher = epoch > mine.epoch
  const tie = epoch === mine.epoch && mine.device !== null && mine.device !== device && device < mine.device
  if (!higher && !tie) return false
  await writeMain(db, { device, epoch })
  return true
}

/**
 * Joining: the shop's main becomes this till's main.
 *
 * Unconditionally when this till has nobody else, because joining *is*
 * accepting the shop's main, whatever number this machine was carrying from a
 * life before. A till that already has tills of its own is a main joining
 * another main, and there the ordinary rule decides.
 */
export async function joinedMain(
  db: SqlDriver,
  joined: string,
  said: { device?: unknown; epoch?: unknown } | null | undefined,
): Promise<void> {
  const device = typeof said?.device === 'string' && said.device !== '' ? said.device : null
  const epoch = typeof said?.epoch === 'number' && Number.isInteger(said.epoch) ? said.epoch : 0
  if (device === null || epoch < 1) return

  const others = (await peersWithSecrets(db)).filter((p) => p.deviceId !== joined)
  if (others.length > 0) {
    await hearMain(db, { device, epoch })
    return
  }
  await writeMain(db, { device, epoch })
}

/**
 * A person makes this till the main.
 *
 * For the day the main is gone -- dead, stolen, under water -- and for moving
 * the main to a machine of one's choosing. Never automatic: safe automatic
 * failover needs three voters and a two-till shop has two, which is why
 * two-node systems everywhere either add a witness or switch by hand.
 *
 * The epoch goes one past the highest this till has heard, so every till that
 * meets this one follows it, and an old main that comes back steps down at
 * first contact rather than splitting the shop.
 */
export async function makeThisTheMain(db: SqlDriver, actorId: string | null | undefined): Promise<MainTill> {
  await requirePermission(db, actorId, 'settings', 'write')
  const me = deviceId()
  if (me === null) throw new Error('This machine does not know which machine it is')
  const mine = await mainTill(db)
  if (mine.device === me) return mine
  const next = { device: me, epoch: mine.epoch + 1 }
  await writeMain(db, next)
  return next
}

/**
 * The main hands its place to one of its tills, while it is still working.
 *
 * The planned move, and the gentle one: the till named here learns it is the
 * main the next time it dials this one, and starts answering. This till goes
 * on answering the tills that dial it until each has paired with the new main
 * (`listens`), so nothing is stranded in between and nothing has to happen in
 * a particular order.
 */
export async function handTheMainTo(
  db: SqlDriver,
  to: string,
  actorId: string | null | undefined,
): Promise<MainTill> {
  await requirePermission(db, actorId, 'settings', 'write')
  const mine = await mainTill(db)
  if (await tillRole(db) !== 'main') throw new Error('Only the main till can hand its place on')
  const peers = await peersWithSecrets(db)
  if (!peers.some((p) => p.deviceId === to)) throw new Error('That till is not paired with this one')
  const next = { device: to, epoch: mine.epoch + 1 }
  await writeMain(db, next)
  return next
}
