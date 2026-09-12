import { describe, it, expect } from 'vitest'
import { businessDate, addDays } from '../src/dates.js'

describe('business date', () => {
  /* The bug this exists to prevent: in IST, 00:30 on the 13th is 19:00 UTC on the
     12th, so toISOString() would file the bill against a drawer already closed. */
  it('takes the calendar date the shop is in, not UTC', () => {
    const justAfterMidnight = new Date(2026, 8, 13, 0, 30)
    expect(businessDate(justAfterMidnight)).toBe('2026-09-13')

    const lateEvening = new Date(2026, 8, 12, 23, 45)
    expect(businessDate(lateEvening)).toBe('2026-09-12')
  })

  it('pads a single-digit month and day', () => {
    expect(businessDate(new Date(2026, 0, 5, 14, 0))).toBe('2026-01-05')
  })

  it('walks across a month boundary in both directions', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})
