import { describe, it, expect } from 'vitest'
import { rupees, ZERO } from '../src/money.js'
import {
  calculateEarned, availablePoints, planRedemption, reachesMonthlyTarget, programProblem,
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
  monthlyTarget: ZERO,
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

describe('a monthly target', () => {
  const withTarget = { ...program, monthlyTarget: rupees(5000) }

  it('earns nothing while the month is short of it', () => {
    const r = calculateEarned(withTarget, { grandTotal: rupees(1000), creditPortion: ZERO, monthToDate: rupees(3000) }, now)
    expect(r.points).toBe(0)
  })

  it('earns on the bill that reaches it', () => {
    const r = calculateEarned(withTarget, { grandTotal: rupees(2000), creditPortion: ZERO, monthToDate: rupees(3000) }, now)
    expect(r.points).toBe(20)
  })

  it('earns on every bill once the month is past it', () => {
    const r = calculateEarned(withTarget, { grandTotal: rupees(500), creditPortion: ZERO, monthToDate: rupees(8000) }, now)
    expect(r.points).toBe(5)
  })

  it('counts the lines the programme covers, not the whole bill', () => {
    const basis = { grandTotal: rupees(2000), creditPortion: ZERO, earningTotal: rupees(1500), monthToDate: rupees(3000) }
    expect(calculateEarned(withTarget, basis, now).points).toBe(0)
  })

  it('counts a khata bill towards it, and then earns only on what was paid', () => {
    const r = calculateEarned(withTarget, { grandTotal: rupees(2000), creditPortion: rupees(1000), monthToDate: rupees(3000) }, now)
    expect(r.points).toBe(10)
  })

  it('is off at zero, whatever the month holds', () => {
    expect(calculateEarned(program, { grandTotal: rupees(1000), creditPortion: ZERO }, now).points).toBe(10)
  })

  it('reads a program saved before the target existed as having none', () => {
    const { monthlyTarget: _dropped, ...old } = withTarget
    expect(reachesMonthlyTarget(old as LoyaltyProgram, ZERO, rupees(1))).toBe(true)
  })

  it('refuses a negative or half-typed target', () => {
    expect(programProblem({ ...program, monthlyTarget: -1 as never })).toMatch(/monthly target/)
    expect(programProblem({ ...program, monthlyTarget: NaN as never })).toMatch(/monthly target/)
    expect(programProblem(withTarget)).toBeNull()
  })
})

describe('earning', () => {
  it('awards points at the matching tier', () => {
    expect(calculateEarned(program, { grandTotal: rupees(1000), creditPortion: ZERO }, now).points).toBe(10)
  })

  it('uses the higher tier above its threshold', () => {
    expect(calculateEarned(program, { grandTotal: rupees(6000), creditPortion: ZERO }, now).points).toBe(120)
  })

  it('excludes the credit portion by default — points on money not yet received', () => {
    const r = calculateEarned(program, { grandTotal: rupees(1000), creditPortion: rupees(600) }, now)
    expect(r.eligibleSpend).toBe(rupees(400))
    expect(r.points).toBe(4)
  })

  it('includes the credit portion when the shop opts in', () => {
    const r = calculateEarned({ ...program, earnOnCreditPortion: true }, { grandTotal: rupees(1000), creditPortion: rupees(600) }, now)
    expect(r.points).toBe(10)
  })

  it('awards nothing below the minimum bill', () => {
    expect(calculateEarned(program, { grandTotal: rupees(50), creditPortion: ZERO }, now).points).toBe(0)
  })

  it('awards nothing on a fully-credit bill', () => {
    expect(calculateEarned(program, { grandTotal: rupees(1000), creditPortion: rupees(1000) }, now).points).toBe(0)
  })

  it('awards nothing when the program is off', () => {
    expect(calculateEarned({ ...program, enabled: false }, { grandTotal: rupees(1000), creditPortion: ZERO }, now).points).toBe(0)
  })

  it('sets an expiry when the program has one', () => {
    const r = calculateEarned(program, { grandTotal: rupees(1000), creditPortion: ZERO }, now)
    expect(r.expiresAt).toBe('2027-06-01T00:00:00.000Z')
  })

  it('leaves expiry null when points never expire', () => {
    expect(calculateEarned({ ...program, expiryDays: null }, { grandTotal: rupees(1000), creditPortion: ZERO }, now).expiresAt).toBeNull()
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

/* The same reason as the discount block: a bill that is mostly mobile recharge
   must not pay points on the recharge. */
describe('earning only on what the shop can afford', () => {
  it('earns on the eligible part, not the whole bill', () => {
    const r = calculateEarned(
      program,
      { grandTotal: rupees(1000), creditPortion: ZERO, earningTotal: rupees(200) },
      now,
    )
    expect(r.eligibleSpend).toBe(rupees(200))
    expect(r.points).toBe(2)
  })

  it('earns nothing when every line on the bill is excluded', () => {
    const r = calculateEarned(program, { grandTotal: rupees(1000), creditPortion: ZERO, earningTotal: ZERO }, now)
    expect(r.points).toBe(0)
  })

  /* Which lines the unpaid money belongs to is unanswerable, so credit comes off
     the earning part first — fewer points is the error a shop can live with. */
  it('takes credit off the earning part first', () => {
    const r = calculateEarned(
      program,
      { grandTotal: rupees(1000), creditPortion: rupees(900), earningTotal: rupees(500) },
      now,
    )
    expect(r.eligibleSpend).toBe(rupees(100))
  })

  it('earns on the whole eligible part when the programme pays on credit too', () => {
    const r = calculateEarned(
      { ...program, earnOnCreditPortion: true },
      { grandTotal: rupees(1000), creditPortion: rupees(900), earningTotal: rupees(500) },
      now,
    )
    expect(r.eligibleSpend).toBe(rupees(500))
  })

  it('treats a bill with nothing excluded exactly as before', () => {
    const withOut = calculateEarned(program, { grandTotal: rupees(1000), creditPortion: ZERO }, now)
    const withFull = calculateEarned(
      program,
      { grandTotal: rupees(1000), creditPortion: ZERO, earningTotal: rupees(1000) },
      now,
    )
    expect(withOut).toEqual(withFull)
  })
})
