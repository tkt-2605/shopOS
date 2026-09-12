import { describe, it, expect } from 'vitest'
import { rupees, ZERO } from '../src/money.js'
import { planAllocation, checkCreditLimit, totalOutstanding, type OpenBill } from '../src/domain/credit.js'

const bill = (id: string, date: string, credit: number, allocated = 0): OpenBill => ({
  id,
  docNo: id,
  postingDate: date,
  creditTotal: rupees(credit),
  allocated: rupees(allocated),
})

describe('outstanding', () => {
  it('is the sum of unsettled credit', () => {
    expect(totalOutstanding([bill('a', '2026-01-01', 500), bill('b', '2026-01-02', 300, 100)])).toBe(rupees(700))
  })

  it('is zero for a fully settled book', () => {
    expect(totalOutstanding([bill('a', '2026-01-01', 500, 500)])).toBe(ZERO)
  })
})

describe('payment allocation', () => {
  const open = [
    bill('c', '2026-03-01', 300),
    bill('a', '2026-01-01', 500),
    bill('b', '2026-02-01', 200),
  ]

  it('clears oldest first', () => {
    const plan = planAllocation(rupees(600), open)
    expect(plan.allocations).toEqual([
      { billId: 'a', amount: rupees(500) },
      { billId: 'b', amount: rupees(100) },
    ])
    expect(plan.unallocated).toBe(ZERO)
  })

  it('leaves the remainder unallocated when the payment exceeds the book', () => {
    const plan = planAllocation(rupees(2000), open)
    expect(plan.allocated).toBe(rupees(1000))
    expect(plan.unallocated).toBe(rupees(1000))
  })

  it('never allocates more than a bill is due', () => {
    const plan = planAllocation(rupees(10_000), open)
    for (const a of plan.allocations) {
      const source = open.find((b) => b.id === a.billId)!
      expect(a.amount).toBeLessThanOrEqual(source.creditTotal - source.allocated)
    }
  })

  it('skips bills already settled', () => {
    const plan = planAllocation(rupees(100), [bill('done', '2026-01-01', 500, 500), bill('open', '2026-02-01', 50)])
    expect(plan.allocations).toEqual([{ billId: 'open', amount: rupees(50) }])
  })

  it('does nothing for a zero payment', () => {
    expect(planAllocation(ZERO, open).allocations).toEqual([])
  })

  it('conserves the payment amount exactly', () => {
    for (const amount of [1, 99, 100, 499, 1000, 1001]) {
      const plan = planAllocation(rupees(amount), open)
      const summed = plan.allocations.reduce((s, a) => s + a.amount, 0)
      expect(summed + plan.unallocated).toBe(rupees(amount))
    }
  })
})

describe('credit limit', () => {
  it('allows a sale within the limit', () => {
    const r = checkCreditLimit({
      creditLimit: rupees(1000),
      enforcement: 'hard',
      currentOutstanding: rupees(400),
      additionalCredit: rupees(500),
    })
    expect(r.allowed).toBe(true)
  })

  it('blocks a hard-enforced overrun', () => {
    const r = checkCreditLimit({
      creditLimit: rupees(1000),
      enforcement: 'hard',
      currentOutstanding: rupees(900),
      additionalCredit: rupees(500),
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.code).toBe('CREDIT_LIMIT_EXCEEDED')
      expect(r.excess).toBe(rupees(400))
    }
  })

  it('warns but permits a soft-enforced overrun', () => {
    const r = checkCreditLimit({
      creditLimit: rupees(1000),
      enforcement: 'soft',
      currentOutstanding: rupees(900),
      additionalCredit: rupees(500),
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.warning).toBe('OVER_LIMIT')
  })

  it('ignores the limit when enforcement is off', () => {
    const r = checkCreditLimit({
      creditLimit: rupees(10),
      enforcement: 'none',
      currentOutstanding: rupees(9000),
      additionalCredit: rupees(5000),
    })
    expect(r.allowed).toBe(true)
  })

  it('treats a zero limit as unlimited rather than as a block', () => {
    const r = checkCreditLimit({
      creditLimit: ZERO,
      enforcement: 'hard',
      currentOutstanding: rupees(9000),
      additionalCredit: rupees(5000),
    })
    expect(r.allowed).toBe(true)
  })

  it('allows a cash sale to a customer already over limit', () => {
    const r = checkCreditLimit({
      creditLimit: rupees(100),
      enforcement: 'hard',
      currentOutstanding: rupees(9000),
      additionalCredit: ZERO,
    })
    expect(r.allowed).toBe(true)
  })
})
