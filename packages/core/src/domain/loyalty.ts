import { type Money, ZERO, add, sub, min as minMoney } from '../money.js'

/**
 * Points are earned per bill into an entry that carries its own expiry, and
 * redeemed by consuming entries soonest-to-expire first. Every redemption records
 * which entries it drew from, so cancelling a bill gives back exactly what that
 * bill took rather than a recomputed guess.
 */

const PAISE_PER_HUNDRED_RUPEES = 10_000

export interface LoyaltyTier {
  minSpend: Money
  /** Points granted per ₹100 of eligible spend. */
  pointsPerHundred: number
}

export interface LoyaltyProgram {
  enabled: boolean
  tiers: LoyaltyTier[]
  expiryDays: number | null
  pointValue: Money
  /** Points on the credit portion of a bill are earned on money not yet received. */
  earnOnCreditPortion: boolean
  minBillForEarn: Money
  maxRedeemFractionBp: number
  /**
   * What a customer has to spend in a calendar month before their bills earn,
   * or zero for no target. The bill that reaches it earns; the bills before it
   * in the month do not earn after the fact.
   */
  monthlyTarget: Money
}

export const DEFAULT_PROGRAM: LoyaltyProgram = {
  enabled: false,
  tiers: [],
  expiryDays: 365,
  pointValue: 100 as Money,
  earnOnCreditPortion: false,
  minBillForEarn: ZERO,
  maxRedeemFractionBp: 10_000,
  monthlyTarget: ZERO,
}

export interface LoyaltyEntry {
  id: string
  points: number
  consumed: number
  earnedAt: string
  expiresAt: string | null
  cancelledAt: string | null
}

export interface EarnResult {
  points: number
  eligibleSpend: Money
  expiresAt: string | null
}

/**
 * What a bill offers the programme to earn on.
 *
 * `earningTotal` is the bill less the lines excluded from the programme. It is
 * separate from `grandTotal` because the two answer different questions: the
 * grand total is what the customer pays, the earning total is what the shop can
 * afford to pay points on. A bill of ₹1,000 that is ₹900 of mobile recharge
 * earns on ₹100.
 */
export interface EarnBasis {
  grandTotal: Money
  creditPortion: Money
  /** Defaults to the whole bill, which is the answer when nothing is excluded. */
  earningTotal?: Money
  /**
   * What the customer spent earlier in this bill's month, on the same footing
   * as `earningTotal`. Only read when the program has a monthly target.
   */
  monthToDate?: Money
}

export function calculateEarned(
  program: LoyaltyProgram,
  basis: EarnBasis,
  on: Date = new Date(),
): EarnResult {
  if (!program.enabled || program.tiers.length === 0) {
    return { points: 0, eligibleSpend: ZERO, expiresAt: null }
  }

  const { grandTotal, creditPortion } = basis
  const earningTotal = basis.earningTotal ?? grandTotal

  // Credit comes off the earning part first. It is the conservative reading of
  // an unanswerable question — which lines the unpaid money belongs to — and
  // erring towards fewer points is the error a shop can live with.
  const eligibleSpend = program.earnOnCreditPortion
    ? earningTotal
    : minMoney(earningTotal, sub(grandTotal, creditPortion))

  if (eligibleSpend <= 0 || eligibleSpend < program.minBillForEarn) {
    return { points: 0, eligibleSpend: ZERO, expiresAt: null }
  }

  if (!reachesMonthlyTarget(program, basis.monthToDate ?? ZERO, earningTotal)) {
    return { points: 0, eligibleSpend, expiresAt: null }
  }

  const tier = tierFor(program.tiers, eligibleSpend)
  if (!tier) return { points: 0, eligibleSpend, expiresAt: null }

  const points = Math.floor(eligibleSpend / PAISE_PER_HUNDRED_RUPEES) * tier.pointsPerHundred
  if (points <= 0) return { points: 0, eligibleSpend, expiresAt: null }

  return { points, eligibleSpend, expiresAt: expiryFrom(program, on) }
}

/**
 * Whether this bill takes the customer's month to the target.
 *
 * Counted on the earning total, not on what was paid: the target is about how
 * much the customer buys, and a regular on khata is still a regular. Whether
 * the credit part then earns is `earnOnCreditPortion`'s question, asked after.
 */
export function reachesMonthlyTarget(program: LoyaltyProgram, monthToDate: Money, thisBill: Money): boolean {
  const target = program.monthlyTarget ?? ZERO
  if (target <= 0) return true
  return add(monthToDate, thisBill) >= target
}

function tierFor(tiers: LoyaltyTier[], spend: Money): LoyaltyTier | null {
  let best: LoyaltyTier | null = null
  for (const tier of tiers) {
    if (tier.minSpend > spend) continue
    if (best === null || tier.minSpend > best.minSpend) best = tier
  }
  return best
}

function expiryFrom(program: LoyaltyProgram, on: Date): string | null {
  if (program.expiryDays === null) return null
  const expiry = new Date(on.getTime())
  expiry.setUTCDate(expiry.getUTCDate() + program.expiryDays)
  return expiry.toISOString()
}

export function isLive(entry: LoyaltyEntry, asOf: string): boolean {
  if (entry.cancelledAt !== null) return false
  if (entry.expiresAt !== null && entry.expiresAt <= asOf) return false
  return entry.points > entry.consumed
}

export function availablePoints(entries: LoyaltyEntry[], on: Date = new Date()): number {
  const asOf = on.toISOString()
  return entries.reduce((sum, e) => (isLive(e, asOf) ? sum + (e.points - e.consumed) : sum), 0)
}

export interface RedemptionAllocation {
  entryId: string
  points: number
}

export interface RedemptionPlan {
  ok: true
  allocations: RedemptionAllocation[]
  points: number
  value: Money
}

export interface RedemptionShortfall {
  ok: false
  code: 'INSUFFICIENT_POINTS' | 'EXCEEDS_BILL_CAP' | 'PROGRAM_DISABLED'
  available: number
  requested: number
  maxAllowed?: number
}

export function planRedemption(
  program: LoyaltyProgram,
  entries: LoyaltyEntry[],
  requestedPoints: number,
  billTotal: Money,
  on: Date = new Date(),
): RedemptionPlan | RedemptionShortfall {
  const asOf = on.toISOString()
  const available = availablePoints(entries, on)

  if (!program.enabled) {
    return { ok: false, code: 'PROGRAM_DISABLED', available, requested: requestedPoints }
  }
  if (requestedPoints <= 0) {
    return { ok: true, allocations: [], points: 0, value: ZERO }
  }
  if (requestedPoints > available) {
    return { ok: false, code: 'INSUFFICIENT_POINTS', available, requested: requestedPoints }
  }

  const capValue = Math.floor((billTotal * program.maxRedeemFractionBp) / 10_000)
  const maxByCap = Math.floor(capValue / program.pointValue)
  if (requestedPoints > maxByCap) {
    return {
      ok: false,
      code: 'EXCEEDS_BILL_CAP',
      available,
      requested: requestedPoints,
      maxAllowed: maxByCap,
    }
  }

  // Soonest expiry first, so points the customer is about to lose get spent.
  const live = entries
    .filter((e) => isLive(e, asOf))
    .sort((a, b) => {
      const ax = a.expiresAt ?? '9999'
      const bx = b.expiresAt ?? '9999'
      return ax === bx ? a.earnedAt.localeCompare(b.earnedAt) : ax.localeCompare(bx)
    })

  const allocations: RedemptionAllocation[] = []
  let remaining = requestedPoints
  for (const entry of live) {
    if (remaining === 0) break
    const take = Math.min(remaining, entry.points - entry.consumed)
    if (take <= 0) continue
    allocations.push({ entryId: entry.id, points: take })
    remaining -= take
  }

  const points = requestedPoints - remaining
  return { ok: true, allocations, points, value: pointsToMoney(program, points, billTotal) }
}

export function pointsToMoney(program: LoyaltyProgram, points: number, billTotal: Money): Money {
  const raw = (points * program.pointValue) as Money
  return minMoney(raw, billTotal)
}

/**
 * What is wrong with a program as typed, in words for the owner, or null.
 *
 * The settings form read its boxes with `Number(...)`, so "abc" became NaN, which
 * JSON writes as null, and a program with a null point value or expiry then
 * broke earning and redemption on every bill after it was saved.
 */
export function programProblem(program: LoyaltyProgram): string | null {
  const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n)
  if (!whole(program.pointValue) || program.pointValue <= 0) return 'A point has to be worth more than nothing.'
  if (program.expiryDays !== null && (!whole(program.expiryDays) || program.expiryDays <= 0)) {
    return 'Points expire after a whole number of days, or leave it blank for never.'
  }
  if (!whole(program.minBillForEarn) || program.minBillForEarn < 0) return 'The minimum bill cannot be below zero.'
  if (!whole(program.monthlyTarget) || program.monthlyTarget < 0) {
    return 'The monthly target is an amount of zero or more; zero means none.'
  }
  if (!whole(program.maxRedeemFractionBp) || program.maxRedeemFractionBp < 0 || program.maxRedeemFractionBp > 10_000) {
    return 'Points can pay between 0 and 100 per cent of a bill.'
  }
  for (const tier of program.tiers) {
    if (!whole(tier.minSpend) || tier.minSpend < 0) return 'Every tier needs a bill amount of zero or more.'
    if (!Number.isFinite(tier.pointsPerHundred) || tier.pointsPerHundred < 0) {
      return 'Every tier needs a number of points per ₹100, zero or more.'
    }
  }
  return null
}
