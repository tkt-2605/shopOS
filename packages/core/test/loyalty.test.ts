import { describe, it, expect } from 'vitest'
import { rupees, ZERO } from '../src/money.js'
import {
  calculateEarned, availablePoints, planRedemption,
  type LoyaltyProgram, type LoyaltyEntry,
} from '../src/domain/loyalty.js'

const program: LoyaltyProgram = {
  enabled: true,
  tiers: [
    { minSpend: ZERO, pointsPerHundred: 1 },
    { minSpend: rupees(5000), pointsPerHundred: 2 },
  ],
  expiryDays: 365,
  pointValue: rupees(1),
  earnOnCreditPortion: false,
  minBillForEarn: rupees(100),
  maxRedeemFractionBp: 5000,
}

const entry = (id: string, points: number, opts: Partial<LoyaltyEntry> = {}): LoyaltyEntry => ({
  id,
  points,
  consumed: 0,
  earnedAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  cancelledAt: null,
  ...opts,
})

const now = new Date('2026-06-01T00:00:00Z')

describe('earning', () => {
  it('awards points at the matching tier', () => {
    expect(calculateEarned(program, rupees(1000), ZERO, now).points).toBe(10)
  })

  it('uses the higher tier above its threshold', () => {
    expect(calculateEarned(program, rupees(6000), ZERO, now).points).toBe(120)
  })

  it('excludes the credit portion by default — points on money not yet received', () => {
    const r = calculateEarned(program, rupees(1000), rupees(600), now)
    expect(r.eligibleSpend).toBe(rupees(400))
    expect(r.points).toBe(4)
  })

  it('includes the credit portion when the shop opts in', () => {
    const r = calculateEarned({ ...program, earnOnCreditPortion: true }, rupees(1000), rupees(600), now)
    expect(r.points).toBe(10)
  })

  it('awards nothing below the minimum bill', () => {
    expect(calculateEarned(program, rupees(50), ZERO, now).points).toBe(0)
  })

  it('awards nothing on a fully-credit bill', () => {
    expect(calculateEarned(program, rupees(1000), rupees(1000), now).points).toBe(0)
  })

  it('awards nothing when the program is off', () => {
    expect(calculateEarned({ ...program, enabled: false }, rupees(1000), ZERO, now).points).toBe(0)
  })

  it('sets an expiry when the program has one', () => {
    const r = calculateEarned(program, rupees(1000), ZERO, now)
    expect(r.expiresAt).toBe('2027-06-01T00:00:00.000Z')
  })

  it('leaves expiry null when points never expire', () => {
    expect(calculateEarned({ ...program, expiryDays: null }, rupees(1000), ZERO, now).expiresAt).toBeNull()
  })
})

describe('available points', () => {
  it('ignores expired entries', () => {
    const entries = [entry('a', 100, { expiresAt: '2026-01-01T00:00:00Z' }), entry('b', 50)]
    expect(availablePoints(entries, now)).toBe(50)
  })

  it('ignores cancelled entries', () => {
    expect(availablePoints([entry('a', 100, { cancelledAt: '2026-02-01T00:00:00Z' })], now)).toBe(0)
  })

  it('counts only the unconsumed remainder', () => {
    expect(availablePoints([entry('a', 100, { consumed: 70 })], now)).toBe(30)
  })
})

describe('redemption', () => {
  it('consumes soonest-to-expire first so points are not wasted', () => {
    const entries = [
      entry('later', 100, { expiresAt: '2027-01-01T00:00:00Z' }),
      entry('sooner', 100, { expiresAt: '2026-07-01T00:00:00Z' }),
    ]
    const plan = planRedemption(program, entries, 150, rupees(10_000), now)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.allocations[0]).toEqual({ entryId: 'sooner', points: 100 })
      expect(plan.allocations[1]).toEqual({ entryId: 'later', points: 50 })
    }
  })

  it('records exactly which entries it drew from, so a reversal is exact', () => {
    const plan = planRedemption(program, [entry('a', 30), entry('b', 30)], 45, rupees(10_000), now)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.allocations.reduce((s, a) => s + a.points, 0)).toBe(45)
    }
  })

  it('refuses to redeem more than the customer has', () => {
    const plan = planRedemption(program, [entry('a', 10)], 50, rupees(10_000), now)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('INSUFFICIENT_POINTS')
      expect(plan.available).toBe(10)
    }
  })

  it('will not let points pay for more of the bill than the cap allows', () => {
    const plan = planRedemption(program, [entry('a', 10_000)], 600, rupees(1000), now)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('EXCEEDS_BILL_CAP')
      expect(plan.maxAllowed).toBe(500)
    }
  })

  it('will not spend expired points', () => {
    const plan = planRedemption(
      program,
      [entry('gone', 500, { expiresAt: '2026-01-01T00:00:00Z' })],
      100,
      rupees(10_000),
      now,
    )
    expect(plan.ok).toBe(false)
  })

  it('treats zero as a no-op', () => {
    const plan = planRedemption(program, [entry('a', 100)], 0, rupees(1000), now)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.allocations).toEqual([])
  })

  it('refuses when the program is disabled', () => {
    const plan = planRedemption({ ...program, enabled: false }, [entry('a', 100)], 10, rupees(1000), now)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('PROGRAM_DISABLED')
  })
})
