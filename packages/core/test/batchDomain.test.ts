import { describe, it, expect } from 'vitest'
import {
  allocate, batchIdFor, expiryState, formatExpiry, normalizeBatchNo, parseExpiry, unbatchedOf,
  type BatchStock,
} from '../src/domain/batches.js'
import { fromUnits, toUnits, QTY_ZERO } from '../src/quantity.js'

/**
 * The rules for batches that need no database: what a batch number and an
 * expiry date are, and which batch a sale comes out of.
 */

const TODAY = '2026-09-27'

function batch(batchNo: string, units: number, expiryDate: string | null): BatchStock {
  return { batchId: batchNo, batchNo, expiryDate, balance: fromUnits(units) }
}

const taken = (a: ReturnType<typeof allocate>) => a.takes.map((t) => [t.batchId, toUnits(t.qty)])

describe('a batch number', () => {
  it('is the same batch however it was typed', () => {
    expect(normalizeBatchNo(' b  1234 ')).toBe('B 1234')
    expect(normalizeBatchNo('B 1234')).toBe('B 1234')
    expect(batchIdFor('p1', normalizeBatchNo('bx9')!)).toBe(batchIdFor('p1', 'BX9'))
  })

  it('is nothing when nothing was typed', () => {
    expect(normalizeBatchNo('   ')).toBeNull()
    expect(normalizeBatchNo(undefined)).toBeNull()
  })

  it('belongs to its product: the same number on two products is two batches', () => {
    expect(batchIdFor('p1', 'A1')).not.toBe(batchIdFor('p2', 'A1'))
  })
})

describe('an expiry date as a person types it', () => {
  it('reads a month as the last day of it, as the pack means', () => {
    expect(parseExpiry('03/2027')).toEqual({ ok: true, value: '2027-03-31' })
    expect(parseExpiry('2/28')).toEqual({ ok: true, value: '2028-02-29' })
    expect(parseExpiry('11-2026')).toEqual({ ok: true, value: '2026-11-30' })
  })

  it('takes a whole date as given', () => {
    expect(parseExpiry('15/03/2027')).toEqual({ ok: true, value: '2027-03-15' })
    expect(parseExpiry('2027-03-15')).toEqual({ ok: true, value: '2027-03-15' })
    expect(parseExpiry('5/1/27')).toEqual({ ok: true, value: '2027-01-05' })
  })

  it('allows none at all', () => {
    expect(parseExpiry('')).toEqual({ ok: true, value: null })
  })

  it('refuses what is not a date', () => {
    for (const bad of ['13/2027', '31/02/2027', 'soon', '2027', '00/2027']) {
      expect(parseExpiry(bad), bad).toEqual({ ok: false })
    }
  })

  it('is shown back the way it was printed', () => {
    expect(formatExpiry('2027-03-31')).toBe('03/2027')
    expect(formatExpiry('2027-03-15')).toBe('15/03/2027')
    expect(formatExpiry(null)).toBe('')
  })
})

describe('where a batch stands', () => {
  it('is still in date on its expiry day, and expired the day after', () => {
    expect(expiryState('2026-09-27', TODAY)).toBe('soon')
    expect(expiryState('2026-09-26', TODAY)).toBe('expired')
  })

  it('is soon within the window and fine beyond it', () => {
    expect(expiryState('2026-12-01', TODAY)).toBe('soon')
    expect(expiryState('2027-06-01', TODAY)).toBe('ok')
    expect(expiryState(null, TODAY)).toBe('none')
  })
})

describe('which batch a sale comes out of', () => {
  it('takes the soonest to expire first', () => {
    const pool = [batch('LATE', 10, '2027-06-30'), batch('EARLY', 10, '2027-01-31')]
    expect(taken(allocate(pool, QTY_ZERO, fromUnits(4), { today: TODAY }))).toEqual([['EARLY', 4]])
  })

  it('moves on to the next batch when the first runs out', () => {
    const pool = [batch('B', 10, '2027-06-30'), batch('A', 3, '2027-01-31')]
    const plan = allocate(pool, QTY_ZERO, fromUnits(5), { today: TODAY })
    expect(taken(plan)).toEqual([['A', 3], ['B', 2]])
    expect(plan.unbatched).toBe(0)
  })

  it('puts an undated batch after every dated one', () => {
    const pool = [batch('NODATE', 10, null), batch('DATED', 10, '2028-01-31')]
    expect(taken(allocate(pool, QTY_ZERO, fromUnits(1), { today: TODAY }))).toEqual([['DATED', 1]])
  })

  it('takes the batch the cashier picked, whatever its date', () => {
    const pool = [batch('EARLY', 10, '2027-01-31'), batch('LATE', 10, '2027-06-30')]
    expect(taken(allocate(pool, QTY_ZERO, fromUnits(2), { today: TODAY, pick: 'LATE' }))).toEqual([['LATE', 2]])
  })

  it('sells stock with no batch before an expired pack', () => {
    const pool = [batch('OLD', 5, '2026-01-31')]
    const plan = allocate(pool, fromUnits(3), fromUnits(4), { today: TODAY })
    expect(plan.unbatched).toBe(fromUnits(3))
    expect(taken(plan)).toEqual([['OLD', 1]])
    expect(plan.expired, 'and says the sale reached an expired batch').toBe(true)
  })

  it('does not call a sale expired that never touched an expired batch', () => {
    const pool = [batch('OLD', 5, '2026-01-31'), batch('GOOD', 5, '2027-01-31')]
    const plan = allocate(pool, QTY_ZERO, fromUnits(5), { today: TODAY })
    expect(taken(plan)).toEqual([['GOOD', 5]])
    expect(plan.expired).toBe(false)
  })

  it('leaves what nothing covers as unbatched', () => {
    const plan = allocate([batch('A', 2, '2027-01-31')], QTY_ZERO, fromUnits(5), { today: TODAY })
    expect(taken(plan)).toEqual([['A', 2]])
    expect(plan.unbatched).toBe(fromUnits(3))
  })
})

describe('stock no batch accounts for', () => {
  it('is what is on hand less what the batches hold', () => {
    expect(unbatchedOf(fromUnits(10), [batch('A', 4, null), batch('B', 3, null)])).toBe(fromUnits(3))
  })

  it('is never below zero', () => {
    expect(unbatchedOf(fromUnits(2), [batch('A', 4, null)])).toBe(0)
  })
})
