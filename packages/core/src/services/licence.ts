import type { SqlDriver } from '../db/driver.js'
import { getSetting, setSetting, forgetSetting } from './bootstrap.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { businessDate } from '../dates.js'
import type { DeviceStore } from './deviceSettings.js'
import {
  verifyToken, readTokenUnverified, stateOf, allows, overTillLimit,
  GRACE_DAYS, type LicenceToken, type LicenceState, type Tier,
  type GatedFeature, type SigningKey, type VerifyFailure,
} from '../domain/licence.js'
import { LICENCE_KEYS } from '../config/licensing.js'

/**
 * The shop's licence: where it is kept, and what it entitles the shop to.
 *
 * ## Where it is kept
 *
 * In `settings`, which replicates. A licence is a fact about a shop, not
 * about a counter, and a shopkeeper who pastes a renewal code at the front
 * till should not have to walk to the back one and paste it again. It is also
 * the only sensible answer for the till that was switched off that week.
 *
 * The signature travels with it, so a till that receives one by sync verifies
 * it exactly as the till that was typed into did. There is no path by which a
 * peer's say-so installs a licence.
 *
 * ## What is *not* kept there
 *
 * `clock_high_water` is a fact about one machine and lives in that machine's
 * device store. Replicating it would let the till with the furthest-wrong
 * clock poison every other till's idea of whether time is trustworthy.
 *
 * ## The clock
 *
 * A licence that expires is a thing a wall clock can be wound back to defeat,
 * and the standard answer -- refuse to run -- is not available here, because
 * refusing to run is refusing to sell. So the clock is *witnessed* rather than
 * enforced: every start records the latest instant this machine has ever seen,
 * and an entitlement computed at a time well before that high-water mark says
 * `clockUnreliable`. The screen then says the date looks wrong, the paid-for
 * services keep working, and nobody's Saturday is ruined by a flat CMOS
 * battery.
 */

const TOKEN = 'licence_token'
const INSTALLED_AT = 'licence_installed_at'
const HIGH_WATER = 'clock_high_water'

/** How far behind its own high-water mark a clock may be before it is doubted. */
export const CLOCK_SLACK_MS = 24 * 60 * 60 * 1000

export interface Entitlement {
  tier: Tier
  state: LicenceState
  /** Business date, or null for perpetual and for no licence at all. */
  paidThrough: string | null
  graceUntil: string | null
  /** Tills paid for. Advisory: nothing refuses a till over this. */
  tills: number
  /** This machine's clock is behind something it has already seen. */
  clockUnreliable: boolean
  /** The shop this licence names, when one is installed. */
  shopId: string | null
  /**
   * Why there is no entitlement beyond `single`, when a token is installed and
   * did not verify. Null when there is nothing wrong.
   *
   * A stored token that stops verifying is not hypothetical: it is what a key
   * rotation looks like on a till that has not been updated, and the shop
   * needs to be told that rather than shown a blank card.
   */
  problem: VerifyFailure | 'WRONG_SHOP' | null
}

/** A shop with no licence at all. The till works; the paid services do not. */
export const UNLICENSED: Entitlement = {
  tier: 'single', state: 'none', paidThrough: null, graceUntil: null,
  tills: 1, clockUnreliable: false, shopId: null, problem: null,
}

export interface EntitlementOptions {
  now?: Date
  /** This machine's store, for the clock high-water mark. */
  device?: DeviceStore
  /** Overridden by tests and by a build with its own keys. */
  keys?: readonly SigningKey[]
  graceDays?: number
}

/**
 * What this shop is entitled to, right now.
 *
 * Never throws and never blocks: every failure -- no token, a bad token, a
 * token for another shop, no keys in the build -- comes back as an
 * `Entitlement` with `tier: 'single'` and a `problem` naming what happened.
 * A caller that ignores the problem still gets a working till.
 */
export async function entitlement(
  db: SqlDriver, opts: EntitlementOptions = {},
): Promise<Entitlement> {
  const now = opts.now ?? new Date()
  const keys = opts.keys ?? LICENCE_KEYS
  const clockUnreliable = opts.device === undefined ? false : clockLooksWrong(opts.device, now)

  const raw = await getSetting(db, TOKEN)
  if (raw === null || raw.trim() === '') return { ...UNLICENSED, clockUnreliable }

  const verified = await verifyToken(raw, keys)
  if (!verified.ok) {
    return {
      ...UNLICENSED,
      clockUnreliable,
      shopId: readTokenUnverified(raw)?.shopId ?? null,
      problem: verified.code,
    }
  }

  const token = verified.token
  const mine = await getSetting(db, 'shop_id')
  /* A licence for another shop is a restored backup or a copied code, and it
     entitles this shop to nothing. It is kept rather than deleted so the
     screen can say whose it is. */
  if (mine !== null && token.shopId !== mine) {
    return { ...UNLICENSED, clockUnreliable, shopId: token.shopId, problem: 'WRONG_SHOP' }
  }

  const { state, graceUntil } = stateOf(token, businessDate(now), opts.graceDays ?? GRACE_DAYS)

  return {
    tier: token.tier,
    state,
    paidThrough: token.paidThrough,
    graceUntil,
    tills: token.tills,
    clockUnreliable,
    shopId: token.shopId,
    problem: null,
  }
}

/** Whether a gated feature may be used. See `domain/licence.ts` for the list. */
export async function entitled(
  db: SqlDriver, feature: GatedFeature, opts: EntitlementOptions = {},
): Promise<boolean> {
  return allows(await entitlement(db, opts), feature)
}

export type InstallResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; code: VerifyFailure | 'WRONG_SHOP'; shopId: string | null }

/**
 * Stores a licence code, if it is genuine and for this shop.
 *
 * Audited, because a licence changing is a thing somebody did and a thing a
 * support call will ask about. The code itself goes in the diff -- it is not
 * a secret, it is a signed statement about a shop, and it is already stored
 * in a replicating table.
 */
export async function installToken(
  db: SqlDriver, ctx: AuditContext, raw: string, opts: EntitlementOptions = {},
): Promise<InstallResult> {
  const keys = opts.keys ?? LICENCE_KEYS
  const trimmed = raw.trim()

  const verified = await verifyToken(trimmed, keys)
  if (!verified.ok) {
    return { ok: false, code: verified.code, shopId: readTokenUnverified(trimmed)?.shopId ?? null }
  }

  const token = verified.token

  return db.transaction(async (tx) => {
    const mine = await getSetting(tx, 'shop_id')
    if (mine !== null && token.shopId !== mine) {
      return { ok: false as const, code: 'WRONG_SHOP' as const, shopId: token.shopId }
    }

    const before = await getSetting(tx, TOKEN)
    const now = (opts.now ?? new Date()).toISOString()

    await setSetting(tx, TOKEN, trimmed, now)
    await setSetting(tx, INSTALLED_AT, now, now)

    await writeAudit(tx, ctx, {
      entity: 'licence',
      entityId: token.shopId,
      action: before === null ? 'create' : 'update',
      before: before === null ? null : { token: before },
      after: { token: trimmed, tier: token.tier, paidThrough: token.paidThrough },
    })

    return { ok: true as const, entitlement: await entitlement(tx, opts) }
  })
}

/**
 * Removes the licence.
 *
 * Here because a shop that pasted the wrong code needs a way back, and
 * because a restored backup carries somebody else's licence into a new shop.
 * Removing one costs the shop only the paid services, which is why it does
 * not need a confirmation dialog the way the destructive actions do.
 */
export async function removeToken(db: SqlDriver, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await getSetting(tx, TOKEN)
    if (before === null) return

    await forgetSetting(tx, TOKEN)
    await forgetSetting(tx, INSTALLED_AT)
    await writeAudit(tx, ctx, {
      entity: 'licence',
      entityId: readTokenUnverified(before)?.shopId ?? 'unknown',
      action: 'delete',
      before: { token: before },
      after: null,
    })
  })
}

/** The stored token as typed, for the licence card and the diagnostics bundle. */
export async function storedToken(db: SqlDriver): Promise<LicenceToken | null> {
  const raw = await getSetting(db, TOKEN)
  return raw === null ? null : readTokenUnverified(raw)
}

/** How many tills the shop is running over what it has paid for. Never blocks. */
export async function tillOverage(db: SqlDriver, tillsInUse: number): Promise<number> {
  return overTillLimit(await storedToken(db), tillsInUse)
}

/* ── the clock ────────────────────────────────────────────────────────── */

/**
 * Records that this machine has seen this instant.
 *
 * Called on every start and after every successful contact with the portal,
 * which is the one moment a till has a second opinion about the time. Never
 * throws: a device store that cannot be written is already handled everywhere
 * else by carrying on, and a till that cannot remember the date must still
 * sell.
 */
export async function witnessClock(device: DeviceStore, now: Date = new Date()): Promise<void> {
  const seen = device.has(HIGH_WATER)
  const iso = now.toISOString()
  if (seen !== null && seen >= iso) return
  try {
    await device.put(HIGH_WATER, iso)
  } catch {
    // Said on purpose: a machine that cannot record the time still bills.
  }
}

function clockLooksWrong(device: DeviceStore, now: Date): boolean {
  const seen = device.has(HIGH_WATER)
  if (seen === null) return false
  const mark = Date.parse(seen)
  if (Number.isNaN(mark)) return false
  return now.getTime() < mark - CLOCK_SLACK_MS
}
