import { describe, it, expect } from 'vitest'
import { cashNotes } from '../src/pages/billing/cashNotes'

describe('the notes offered for a cash bill', () => {
  it('are the round amounts above the bill a customer is likely to hand over', () => {
    // 360.00: a 400 (fifty and hundred agree), a 500, and a 2,000 note.
    expect(cashNotes(36_000)).toEqual([40_000, 50_000, 200_000])
  })

  it('never offer the exact amount, which a blank box already means', () => {
    expect(cashNotes(50_000)).not.toContain(50_000)
    expect(cashNotes(50_000)[0]).toBe(55_000)
  })

  it('are at most four', () => {
    expect(cashNotes(12_345).length).toBeLessThanOrEqual(4)
  })
})
