import type { SqlDriver } from '../db/driver.js'
import { getSetting, setSetting, forgetSetting } from './settings.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { businessDate } from '../dates.js'
import type { DeviceStore } from './deviceSettings.js'
import {
  verifyToken, readTokenUnverified, stateOf, allowsAny, overTillLimit, tierRank,
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

/**
 * One licence a shop holds.
 *
 * A shop holds a set of these rather than one, because what it buys has two
 * different clocks: a second counter is bought once and never expires, the
 * cloud recurs every year. `allowsAny` in `domain/licence.ts` carries the
 * argument for why that cannot be one token.
 */
export interface Grant {
  tier: Tier
  state: LicenceState
  /** Business date, or null for perpetual. */
  paidThrough: string | null
  graceUntil: string | null
  tills: number
  /** The shop the code names. Every grant here names this one. */
  shopId: string
  /** The code exactly as it was pasted, for showing and copying back out. */
  raw: string
}

export interface Entitlement {
  /**
   * Every licence on this till that verified and names this shop, newest
   * paste last. This is the truth; the fields under it are conveniences
   * derived from it for a screen that wants one headline.
   */
  grants: readonly Grant[]
  /** The best grant currently in force, or `single`/`none` when there is none. */
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
  grants: [], tier: 'single', state: 'none', paidThrough: null, graceUntil: null,
  tills: 1, clockUnreliable: false, shopId: null, problem: null,
}

/**
 * The keys a licence is checked against when a caller names none: the
 * build's own, `LICENCE_KEYS`.
 *
 * A headless bench till is the one thing that changes it. Its shop is
 * licensed with a key minted for the bench, because the shipped key's private
 * half is not in this repository and must never be -- and a bench counter in
 * its own process reaches the money gate (`requireMayTakeMoney`) through
 * `createBill`, which names no keys. Set once, at start, like the clock and
 * the device id; the app never calls it.
 */
let defaultKeys: readonly SigningKey[] = LICENCE_KEYS

export function useLicenceKeys(keys: readonly SigningKey[]): void {
  defaultKeys = keys
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
  const keys = opts.keys ?? defaultKeys
  const clockUnreliable = opts.device === undefined ? false : clockLooksWrong(opts.device, now)

  const codes = await storedCodes(db)
  if (codes.length === 0) return { ...UNLICENSED, clockUnreliable }

  const mine = await getSetting(db, 'shop_id')
  const today = businessDate(now)
  const graceDays = opts.graceDays ?? GRACE_DAYS

  const grants: Grant[] = []
  let problem: Entitlement['problem'] = null
  let problemShop: string | null = null

  for (const raw of codes) {
    const verified = await verifyToken(raw, keys)
    if (!verified.ok) {
      /* The first thing wrong, kept so the screen can say it. Later codes are
         still read: one bad paste must not hide a licence that is fine. */
      problem ??= verified.code
      problemShop ??= readTokenUnverified(raw)?.shopId ?? null
      continue
    }

    const token = verified.token
    /* A licence for another shop is a restored backup or a copied code, and it
       entitles this shop to nothing. It is kept rather than deleted so the
       screen can say whose it is. */
    if (mine !== null && token.shopId !== mine) {
      problem ??= 'WRONG_SHOP'
      problemShop ??= token.shopId
      continue
    }

    const { state, graceUntil } = stateOf(token, today, graceDays)
    grants.push({
      tier: token.tier,
      state,
      paidThrough: token.paidThrough,
      graceUntil,
      tills: token.tills,
      shopId: token.shopId,
      raw,
    })
  }

  if (grants.length === 0) {
    return { ...UNLICENSED, clockUnreliable, shopId: problemShop, problem }
  }

  const best = headline(grants)
  return {
    grants,
    tier: best.tier,
    state: best.state,
    paidThrough: best.paidThrough,
    graceUntil: best.graceUntil,
    /* The most any one licence paid for, not the sum. Two codes are two
       purchases of different things, not two bundles of counters. */
    tills: Math.max(...grants.map((g) => g.tills)),
    clockUnreliable,
    shopId: best.shopId,
    problem,
  }
}

/**
 * The one grant a screen should lead with.
 *
 * The best that is actually in force, so a shop holding a perpetual
 * multi-counter licence and a cloud one that ran out reads as what it is —
 * still licensed — rather than as lapsed. When nothing is in force it falls
 * back to the highest-ranked grant anyway, because then "ran out" is exactly
 * what the shop needs to be told.
 */
function headline(grants: readonly Grant[]): Grant {
  const live = grants.filter((g) => g.state === 'active' || g.state === 'grace')
  const from = live.length > 0 ? live : grants
  return from.reduce((best, g) => (tierRank(g.tier) > tierRank(best.tier) ? g : best), from[0]!)
}

/** Whether a gated feature may be used. See `domain/licence.ts` for the list. */
export async function entitled(
  db: SqlDriver, feature: GatedFeature, opts: EntitlementOptions = {},
): Promise<boolean> {
  /* Asked of every grant, not of the headline. A shop holding a perpetual
     multi-counter code and a cloud code that ran out is still entitled to the
     counter, and asking only the best one would take it away. */
  return allowsAny((await entitlement(db, opts)).grants, feature)
}

/**
 * The codes on this till, in the order they were pasted.
 *
 * Stored newline-separated in the one setting. A licence code is base64url
 * and a dot, so a newline can never appear inside one and needs no escaping —
 * and a single code is just a list of one, which is why a till that was
 * holding one before this existed reads correctly with no migration.
 */
export async function storedCodes(db: SqlDriver): Promise<string[]> {
  const raw = await getSetting(db, TOKEN)
  if (raw === null) return []
  return raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

export type InstallResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; code: VerifyFailure | 'WRONG_SHOP'; shopId: string | null; cause?: string }

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
  const keys = opts.keys ?? defaultKeys
  const trimmed = raw.trim()

  const verified = await verifyToken(trimmed, keys)
  if (!verified.ok) {
    return {
      ok: false, code: verified.code, shopId: readTokenUnverified(trimmed)?.shopId ?? null,
      ...(verified.cause === undefined ? {} : { cause: verified.cause }),
    }
  }

  const token = verified.token

  return db.transaction(async (tx) => {
    const mine = await getSetting(tx, 'shop_id')
    if (mine !== null && token.shopId !== mine) {
      return { ok: false as const, code: 'WRONG_SHOP' as const, shopId: token.shopId }
    }

    const before = await getSetting(tx, TOKEN)
    const now = (opts.now ?? new Date()).toISOString()

    /* Added to what is there, not put in its place — a shop can hold a
       perpetual multi-counter licence and a cloud one that renews yearly, and
       pasting the renewal must not throw the perpetual one away.

       One exception: a code for a tier already held replaces that one, because
       that is what a renewal is. Keeping both would leave last year's date on
       the card next to this year's with nothing to say which is meant. */
    const others: string[] = []
    for (const code of await storedCodes(tx)) {
      if (code === trimmed) continue
      const existing = readTokenUnverified(code)
      if (existing !== null && existing.tier === token.tier) continue
      others.push(code)
    }
    const next = [...others, trimmed]

    await setSetting(tx, TOKEN, next.join('\n'), now)
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
export async function removeToken(
  db: SqlDriver, ctx: AuditContext,
  /** One code, or every code when it is left out. */
  code?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await getSetting(tx, TOKEN)
    if (before === null) return

    const wanted = code?.trim()
    const left = wanted === undefined
      ? []
      : (await storedCodes(tx)).filter((held) => held !== wanted)

    /* Nothing matched, so nothing happened. Said explicitly rather than
       falling through to writing the same list back, which would leave an
       audit row claiming a licence was removed when none was. */
    if (wanted !== undefined && left.length === (await storedCodes(tx)).length) return

    if (left.length === 0) {
      await forgetSetting(tx, TOKEN)
      await forgetSetting(tx, INSTALLED_AT)
    } else {
      await setSetting(tx, TOKEN, left.join('\n'), new Date().toISOString())
    }

    await writeAudit(tx, ctx, {
      entity: 'licence',
      entityId: readTokenUnverified(wanted ?? before)?.shopId ?? 'unknown',
      action: 'delete',
      before: { token: wanted ?? before },
      after: left.length === 0 ? null : { remaining: left.length },
    })
  })
}

/**
 * The best token on this till, parsed and unverified.
 *
 * Singular, and kept singular, because its two callers — the diagnostics
 * bundle and `tillOverage` — both want one answer rather than a list. Which
 * one: the highest tier held, since that is the one that describes what the
 * shop bought. `storedCodes` is there for anything that needs all of them.
 */
export async function storedToken(db: SqlDriver): Promise<LicenceToken | null> {
  const parsed = (await storedCodes(db))
    .map(readTokenUnverified)
    .filter((token): token is LicenceToken => token !== null)
  if (parsed.length === 0) return null
  return parsed.reduce((best, t) => (tierRank(t.tier) > tierRank(best.tier) ? t : best), parsed[0]!)
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
