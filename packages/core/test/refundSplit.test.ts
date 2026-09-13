import { describe, it, expect } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { splitRefund, describeRefund, type RefundBasis } from '../src/domain/returns.js'

/** A bill paid entirely in money, earning and spending nothing. */
function plainBill(total: Money): RefundBasis {
  return {
    billTotal: total,
    pointsValue: 0 as Money,
    pointsRedeemed: 0,
    pointsEarned: 0,
    pointsEarnedSpent: 0,
    alreadyRefunded: 0 as Money,
    alreadyRestoredValue: 0 as Money,
    alreadyRemovedPoints: 0,
  }
}

describe('a bill paid in money alone', () => {
  it('hands back money, and nothing else', () => {
    const split = splitRefund(rupees(500), plainBill(rupees(1000)))
    expect(split.cash).toBe(rupees(500))
    expect(split.pointsRestored).toBe(0)
    expect(split.pointsRemoved).toBe(0)
  })

  it('hands back the whole bill when the whole bill comes back', () => {
    const split = splitRefund(rupees(1000), plainBill(rupees(1000)))
    expect(split.cash).toBe(rupees(1000))
  })
})

describe('a bill part of which was paid with points', () => {
  /* ₹1,000 settled with ₹900 and 100 points worth ₹100. */
  const bill: RefundBasis = {
    ...plainBill(rupees(1000)),
    pointsValue: rupees(100),
    pointsRedeemed: 100,
  }

  /* Refunding ₹500 in cash would hand over ₹50 the customer never paid; adding
     the points on top would hand over ₹100 of it. */
  it('gives back each currency in the share it paid', () => {
    const split = splitRefund(rupees(500), bill)
    expect(split.cash).toBe(rupees(450))
    expect(split.pointsRestored).toBe(50)
    expect(split.restoredValue).toBe(rupees(50))
  })

  it('adds up to the goods, never more', () => {
    const split = splitRefund(rupees(500), bill)
    expect(split.cash + split.restoredValue).toBe(rupees(500))
  })

  it('returns every point when the whole bill comes back', () => {
    const split = splitRefund(rupees(1000), bill)
    expect(split.cash).toBe(rupees(900))
    expect(split.pointsRestored).toBe(100)
  })

  /* Two halves must not become 99 points and a stranded rupee. */
  it('gives back the exact remainder on the last of several returns', () => {
    const first = splitRefund(rupees(333), bill)
    const second = splitRefund(rupees(333), {
      ...bill,
      alreadyRefunded: rupees(333),
      alreadyRestoredValue: first.restoredValue,
    })
    const third = splitRefund(rupees(334), {
      ...bill,
      alreadyRefunded: rupees(666),
      alreadyRestoredValue: (first.restoredValue + second.restoredValue) as Money,
    })

    expect(first.cash + second.cash + third.cash).toBe(rupees(900))
    expect(first.pointsRestored + second.pointsRestored + third.pointsRestored).toBe(100)
  })

  it('never hands back a point twice, however the returns are split', () => {
    const whole = splitRefund(rupees(1000), {
      ...bill, alreadyRefunded: rupees(1000), alreadyRestoredValue: rupees(100),
    })
    expect(whole.pointsRestored).toBe(0)
    expect(whole.cash).toBe(rupees(1000))
  })
})

describe('points the sale earned', () => {
  const earned: RefundBasis = { ...plainBill(rupees(1000)), pointsEarned: 20, pointsEarnedSpent: 0 }

  it('come off in proportion to what went back', () => {
    expect(splitRefund(rupees(500), earned).pointsRemoved).toBe(10)
    expect(splitRefund(rupees(1000), earned).pointsRemoved).toBe(20)
  })

  /* Those points have been spent somewhere else. Taking them back would leave a
     negative balance, which is worse for the shop than absorbing the difference. */
  it('stop at what the customer has already spent', () => {
    const spent = { ...earned, pointsEarnedSpent: 15 }
    expect(splitRefund(rupees(1000), spent).pointsRemoved).toBe(5)
  })

  it('are not taken twice across successive returns', () => {
    const first = splitRefund(rupees(500), earned)
    const second = splitRefund(rupees(500), {
      ...earned,
      pointsEarned: earned.pointsEarned - first.pointsRemoved,
      alreadyRefunded: rupees(500),
      alreadyRemovedPoints: first.pointsRemoved,
    })
    expect(first.pointsRemoved + second.pointsRemoved).toBe(20)
  })
})

describe('the odd cases', () => {
  it('refuses to divide by a bill of nothing', () => {
    const split = splitRefund(rupees(10), plainBill(0 as Money))
    expect(split.cash).toBe(rupees(10))
    expect(split.pointsRestored).toBe(0)
  })

  it('says what the customer gets, in the currencies they get it', () => {
    const money = (m: Money) => `Rs ${m / 100}`
    expect(describeRefund(splitRefund(rupees(500), plainBill(rupees(1000))), money)).toBe('Rs 500')
    expect(describeRefund(
      splitRefund(rupees(500), { ...plainBill(rupees(1000)), pointsValue: rupees(100), pointsRedeemed: 100 }),
      money,
    )).toBe('Rs 450 and 50 points')
  })
})
