import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { writeAudit } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'
import { REPAIR_KEYS } from '../config/repairs.js'
import { verifyPack, type Pack, type PackFailure, type Repair } from '../domain/repairPack.js'
import type { SigningKey } from '../domain/licence.js'
import { getSetting, setSetting } from './settings.js'
import { recomputeStock } from './stock.js'
import { reconcileReturnedQty } from './returns/reconcile.js'
import { reconcileFulfilledQty } from './documents/reconcile.js'
import { reconcileLoyalty } from './loyaltyLedger.js'
import { reconcileDoubleReversals } from './stockReversals.js'
import { retrySetAside } from './sync/setAside.js'
import { applyingRemote } from './changefeed.js'

/*
 * What a repair pack does, said before it is done and then done.
 *
 * Each repair is a fixed operation over the shop's own services: the
 * reconcilers the merge already runs, the merge's own retry of what it set
 * aside, a counter let go the way `clearGhostClaims` lets one go. The preview
 * runs first and says in words what will change; anything in the pack that
 * does not fit this shop -- a counter that is not here, a cursor moved the
 * wrong way -- is a problem the preview names, and a pack with a problem is
 * not applied at all.
 *
 * Each repair is its own transaction with its own audit row naming the pack,
 * and the pack is marked used, in the shop's settings so every till knows,
 * only once all of them are done. A repair that fails stops the rest and
 * leaves the pack unused, so it can be applied again once what stopped it is
 * put right; every repair is safe to run twice.
 */

const USED = (id: string) => `repair_pack:${id}`

export interface RepairPreview {
  kind: Repair['kind']
  /** What will happen, in the words the owner reads before agreeing. */
  says: string
  /** Why it cannot be done here. A pack with any of these is refused whole. */
  problem: string | null
}

export type PackCheck =
  | { ok: true; pack: Pack; previews: RepairPreview[] }
  | { ok: false; code: PackFailure | 'USED' | 'DOES_NOT_FIT'; detail: string; previews?: RepairPreview[] }

const REFUSED: Record<PackFailure | 'USED', string> = {
  MALFORMED: 'That is not a fix from support. Check the whole file or text was copied.',
  NOT_CONFIGURED: 'This copy of ShopOS cannot check fixes from support. Nothing has been changed; please report it.',
  UNKNOWN_KEY: 'This fix was signed with a key this copy does not know. Update ShopOS, then try again.',
  BAD_SIGNATURE: 'This fix did not check out: it may have been changed on the way. Ask support to send it again.',
  WRONG_SHOP: 'This fix was made for a different shop.',
  EXPIRED: 'This fix has expired. Ask support for a fresh one.',
  USED: 'This fix has already been applied in this shop.',
}

/** Verifies a pack and says what it would do here. Changes nothing. */
export async function checkPack(
  db: SqlDriver, raw: string, opts: { now?: Date; keys?: readonly SigningKey[] } = {},
): Promise<PackCheck> {
  const now = opts.now ?? new Date()
  const verified = await verifyPack(raw, opts.keys ?? REPAIR_KEYS, { shopId: await getSetting(db, 'shop_id'), now })
  if (!verified.ok) return { ok: false, code: verified.code, detail: REFUSED[verified.code] }
  const pack = verified.pack
  const used = await getSetting(db, USED(pack.id))
  if (used !== null) return { ok: false, code: 'USED', detail: `${REFUSED.USED} (${used})` }

  const previews: RepairPreview[] = []
  for (const repair of pack.repairs) previews.push(await preview(db, repair))
  if (previews.some((p) => p.problem !== null)) {
    return { ok: false, code: 'DOES_NOT_FIT', detail: 'Part of this fix does not fit this shop, so none of it will be applied.', previews }
  }
  return { ok: true, pack, previews }
}

export type ApplyResult =
  | { ok: true; pack: Pack; done: RepairPreview[] }
  | { ok: false; code: PackFailure | 'USED' | 'DOES_NOT_FIT' | 'FAILED'; detail: string; done?: RepairPreview[] }

export async function applyPack(
  db: SqlDriver,
  input: { raw: string; actorId: string; now?: Date; keys?: readonly SigningKey[] },
): Promise<ApplyResult> {
  await requirePermission(db, input.actorId, 'settings', 'write')
  const now = input.now ?? new Date()
  const checked = await checkPack(db, input.raw, { now, ...(input.keys ? { keys: input.keys } : {}) })
  if (!checked.ok) return { ok: false, code: checked.code, detail: checked.detail }

  const done: RepairPreview[] = []
  for (const [i, repair] of checked.pack.repairs.entries()) {
    try {
      await run(db, repair)
      await db.transaction(async (tx) => {
        await writeAudit(tx, { actorId: input.actorId }, {
          entity: 'settings', entityId: 'repair_pack', action: 'update',
          after: { pack: checked.pack.id, ticket: checked.pack.ticket, repair: repair.kind, says: checked.previews[i]!.says },
        })
      })
      done.push(checked.previews[i]!)
    } catch (e) {
      return {
        ok: false, code: 'FAILED', done,
        detail: `Stopped at "${checked.previews[i]!.says}": ${e instanceof Error ? e.message : String(e)}. `
          + 'What was done before it stays done; the fix can be applied again.',
      }
    }
  }
  await setSetting(db, USED(checked.pack.id), `applied ${now.toISOString()} by ${input.actorId}`, now.toISOString())
  return { ok: true, pack: checked.pack, done }
}

/* ------------------------------------------------------------ each one --- */

async function preview(db: SqlDriver, repair: Repair): Promise<RepairPreview> {
  const say = (says: string, problem: string | null = null): RepairPreview => ({ kind: repair.kind, says, problem })
  switch (repair.kind) {
    case 'reconcile': {
      const counts: string[] = []
      const ask = async (what: Exclude<typeof repair.what, 'all'>, name: string, n: () => Promise<unknown[]>) => {
        if (repair.what === 'all' || repair.what === what) counts.push(`${name} ${(await n()).length}`)
      }
      await ask('stock', 'stock on hand', () => recomputeStock(db))
      await ask('returned', 'returned quantities', () => reconcileReturnedQty(db))
      await ask('fulfilled', 'order quantities billed', () => reconcileFulfilledQty(db))
      await ask('loyalty', 'loyalty points', () => reconcileLoyalty(db))
      await ask('reversals', 'stock reversed twice', () => reconcileDoubleReversals(db))
      return say(`Recount figures from their records; would change: ${counts.join(', ')}.`)
    }
    case 'retry_set_aside': {
      const n = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_quarantine'))?.n ?? 0
      return say(`Try again ${n} record(s) another till sent that could not be taken in.`)
    }
    case 'free_counter': {
      const [r] = await q(db).select({ name: schema.registers.name, prefix: schema.registers.prefix, claimedBy: schema.registers.claimedBy })
        .from(schema.registers).where(eq(schema.registers.id, repair.registerId))
      if (!r) return say(`Let go of a counter (${repair.registerId}).`, 'That counter is not in this shop.')
      return say(r.claimedBy === null
        ? `Counter "${r.name}" (${r.prefix}) is already free; nothing to do.`
        : `Let go of counter "${r.name}" (${r.prefix}), held by till ${r.claimedBy.slice(0, 8)}, so another machine can take it.`)
    }
    case 'renumber_from': {
      const scope = `${repair.docType}:${repair.prefix}:${repair.fiscalYear}`
      const [row] = await q(db).select({ last: schema.docSequences.lastValue }).from(schema.docSequences).where(eq(schema.docSequences.scope, scope))
      const last = row?.last ?? 0
      const words = `${repair.docType} numbers on counter ${repair.prefix} for ${repair.fiscalYear}`
      return say(last + 1 >= repair.next
        ? `Already past number ${repair.next} for ${words}; nothing to do.`
        : `Start ${words} at ${repair.next} on this till (it would have been ${last + 1}).`)
    }
    case 'reset_peer_cursor': {
      const [p] = await q(db).select({ label: schema.syncPeers.label, cursor: schema.syncPeers.theirCursor })
        .from(schema.syncPeers).where(eq(schema.syncPeers.deviceId, repair.deviceId))
      if (!p) return say(`Ask a till for its changes again (${repair.deviceId}).`, 'That till is not paired with this one.')
      if (repair.from > p.cursor) {
        return say(`Move till ${p.label ?? repair.deviceId.slice(0, 8)}'s place forward to ${repair.from}.`, 'That would skip changes this till has not had. Only going back is allowed.')
      }
      return say(`Ask till ${p.label ?? repair.deviceId.slice(0, 8)} for everything again from change ${repair.from} (it is at ${p.cursor}).`)
    }
  }
}

async function run(db: SqlDriver, repair: Repair): Promise<void> {
  switch (repair.kind) {
    case 'reconcile': {
      const all = repair.what === 'all'
      if (all || repair.what === 'stock') await recomputeStock(db, { repair: true })
      if (all || repair.what === 'returned') await reconcileReturnedQty(db, { repair: true })
      if (all || repair.what === 'fulfilled') await reconcileFulfilledQty(db, { repair: true })
      if (all || repair.what === 'loyalty') await reconcileLoyalty(db, { repair: true })
      if (all || repair.what === 'reversals') await reconcileDoubleReversals(db, { repair: true })
      return
    }
    case 'retry_set_aside':
      // The merge's own retry, inside the merge's own marking, so what lands is not news to send back.
      await applyingRemote(db, (tx) => retrySetAside(tx, new Set(), new Map()))
      return
    case 'free_counter':
      await q(db).update(schema.registers)
        .set({ claimedBy: null, claimedAt: null, updatedAt: new Date().toISOString() })
        .where(eq(schema.registers.id, repair.registerId))
      return
    case 'renumber_from': {
      const scope = `${repair.docType}:${repair.prefix}:${repair.fiscalYear}`
      await db.transaction(async (tx) => {
        await q(tx).insert(schema.docSequences).values({ scope, lastValue: 0 }).onConflictDoNothing()
        await q(tx).update(schema.docSequences)
          .set({ lastValue: sql`MAX(${schema.docSequences.lastValue}, ${repair.next - 1})` })
          .where(eq(schema.docSequences.scope, scope))
      })
      return
    }
    case 'reset_peer_cursor':
      await q(db).update(schema.syncPeers)
        .set({ theirCursor: sql`MIN(${schema.syncPeers.theirCursor}, ${repair.from})` })
        .where(eq(schema.syncPeers.deviceId, repair.deviceId))
      return
  }
}
