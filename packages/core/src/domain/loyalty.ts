import { type Money, ZERO, sub, min as minMoney } from '../money.js'

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
}

export const DEFAULT_PROGRAM: LoyaltyProgram = {
  enabled: false,
  tiers: [],
  expiryDays: 365,
  pointValue: 100 as Money,
  earnOnCreditPortion: false,
  minBillForEarn: ZERO,
  maxRedeemFractionBp: 10_000,
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

export function calculateEarned(
  program: LoyaltyProgram,
  grandTotal: Money,
  creditPortion: Money,
  on: Date = new Date(),
): EarnResult {
  if (!program.enabled || program.tiers.length === 0) {
    return { points: 0, eligibleSpend: ZERO, expiresAt: null }
  }

  const eligibleSpend = program.earnOnCreditPortion ? grandTotal : sub(grandTotal, creditPortion)
  if (eligibleSpend <= 0 || eligibleSpend < program.minBillForEarn) {
    return { points: 0, eligibleSpend: ZERO, expiresAt: null }
  }

  const tier = tierFor(program.tiers, eligibleSpend)
  if (!tier) return { points: 0, eligibleSpend, expiresAt: null }

  const points = Math.floor(eligibleSpend / PAISE_PER_HUNDRED_RUPEES) * tier.pointsPerHundred
  if (points <= 0) return { points: 0, eligibleSpend, expiresAt: null }

  return { points, eligibleSpend, expiresAt: expiryFrom(program, on) }
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
