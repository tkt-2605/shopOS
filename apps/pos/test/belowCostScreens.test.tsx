import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Totals, Quantity, type ProductListItem, type BelowCostRefusal } from '@shopos/core'
import { discountAmount, emptyCart } from '../src/core/billCarts'
import { underCostOf, totalsLinesOf } from '../src/pages/billing/cart'
import { TotalsPanel } from '../src/pages/billing/TotalsPanel'
import { retryBelowCost, belowCostMessage } from '../src/ui/belowCost'
import type { CartLine } from '../src/core/useBillTabs'

/**
 * The counter's side of selling below cost, and the percentage discount that
 * makes it easy to do by accident: said while it is typed, asked of the one
 * person who may go ahead, refused with the reason for everyone else.
 */

afterEach(cleanup)

const pen = {
  id: 'pen', name: 'Pen', baseUnit: 'piece', taxRateBp: 0, cessRateBp: 0, discountBlocked: false,
} as unknown as ProductListItem

const line = (rate: number, qty = 1): CartLine => ({
  key: 'l1', product: pen, saleUnit: 'piece', units: [{ saleUnit: 'piece', baseUnits: Quantity.fromUnits(1), isDefault: true }],
  qty, rate, source: 'base_rate', sourceId: null, manual: false,
} as unknown as CartLine)

describe('a percentage discount', () => {
  it('is of what may be discounted, and nothing for a typo', () => {
    expect(discountAmount({ discount: '10', discountPercent: true }, 50000)).toBe(5000)
    expect(discountAmount({ discount: '12.5', discountPercent: true }, 10000)).toBe(1250)
    expect(discountAmount({ discount: 'ten', discountPercent: true }, 10000)).toBe(0)
    expect(discountAmount({ discount: '150', discountPercent: true }, 10000)).toBe(10000)
  })

  it('is rupees as it always was when the switch is on ₹', () => {
    expect(discountAmount({ discount: '10', discountPercent: false }, 50000)).toBe(1000)
  })
})

describe('below cost at the counter', () => {
  const floors = new Map([['pen', 8000]])

  it('says a line the discount takes under its cost, and not one it leaves above', () => {
    const lines = [line(10000)]
    const at = (discount: number) => underCostOf(lines,
      Totals.computeTotals(totalsLinesOf(lines), discount as never).lines.map((t) => t.tax.taxableValue), floors)
    expect(at(1000)).toEqual([])
    expect(at(3000)).toEqual([{ productId: 'pen', name: 'Pen', sellsAt: 7000, cost: 8000 }])
  })

  it('shows the ₹ | % switch and the warning in the totals', () => {
    const onPercent = vi.fn()
    const cart = { ...emptyCart(), lines: [line(10000)], discount: '30', discountPercent: true }
    const totals = Totals.computeTotals(totalsLinesOf(cart.lines), 3000 as never)
    render(<TotalsPanel cart={cart} totals={totals} blocked={[]} needsRecipient={false} loyaltyMonth={null}
      empty={false} unfinished={false} onPickCustomer={vi.fn()} onDiscount={vi.fn()} onDiscountPercent={onPercent}
      onPay={vi.fn()} underCost={[{ productId: 'pen', name: 'Pen', sellsAt: 7000 as never, cost: 8000 as never }]} />)
    expect(screen.getByText('%').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/Below cost: Pen at ₹70\.00, cost ₹80\.00/)).toBeTruthy()
    fireEvent.click(screen.getByText('₹'))
    expect(onPercent).toHaveBeenCalledWith(false)
  })
})

describe('asking to go below cost', () => {
  const refused = (mayAllow: boolean): BelowCostRefusal => ({
    ok: false, code: 'BELOW_COST', mayAllow,
    lines: [{ productId: 'pen', name: 'Pen', sellsAt: 7000 as never, cost: 8000 as never }],
  })

  it('asks somebody who may, and tries again with their yes', async () => {
    const attempt = vi.fn(async (allow: boolean) => (allow ? { ok: true as const } : refused(true)))
    const ask = vi.fn(async () => true)
    expect(await retryBelowCost(attempt, ask, vi.fn())).toEqual({ ok: true })
    expect(attempt).toHaveBeenLastCalledWith(true)
  })

  it('tells anybody else why, and does not try again', async () => {
    const attempt = vi.fn(async () => refused(false))
    const say = vi.fn()
    const ask = vi.fn(async () => true)
    expect(await retryBelowCost(attempt, ask, say)).toBeNull()
    expect(ask).not.toHaveBeenCalled()
    expect(say).toHaveBeenCalledWith(belowCostMessage(refused(false)))
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('leaves alone a save refused for some other reason', async () => {
    const other = { ok: false as const, code: 'BAD_DATES' as const }
    expect(await retryBelowCost(async () => other, vi.fn(), vi.fn())).toBe(other)
  })
})
