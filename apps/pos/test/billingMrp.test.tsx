import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { FEATURES_OFF, Quantity, Totals, type ProductListItem } from '@shopos/core'
import type { CartLine } from '../src/core/useBillTabs'
import { mrpOf, aboveMrp, totalsLinesOf } from '../src/pages/billing/cart'

/**
 * The MRP column on the bill: the printed price for the unit being sold, the
 * batch's where one was chosen, and a rate above it said in red.
 */

vi.mock('../src/core/CoreProvider', () => ({ useCore: () => ({ stockPolicy: 'allow', features: FEATURES_OFF }) }))
const { CartTable } = await import('../src/pages/billing/CartTable')

afterEach(cleanup)

const pen = (mrp: number | null) => ({
  id: 'pen', name: 'Pen', baseUnit: 'piece', taxRateBp: 0, cessRateBp: 0, discountBlocked: false, mrp, qtyOnHand: 100,
}) as unknown as ProductListItem

const line = (over: Partial<CartLine> & { mrp?: number | null } = {}): CartLine => ({
  key: 'l1', product: pen(over.mrp === undefined ? 1000 : over.mrp), saleUnit: 'piece',
  units: [
    { saleUnit: 'piece', baseUnits: Quantity.fromUnits(1), isDefault: true },
    { saleUnit: 'box', baseUnits: Quantity.fromUnits(12), isDefault: false },
  ],
  qty: 1, rate: 900, source: 'base_rate', sourceId: null, manual: false, ...over,
} as unknown as CartLine)

describe('the MRP of a line', () => {
  it('is the item’s for one piece, and twelve times it for a box of twelve', () => {
    expect(mrpOf(line())).toBe(1000)
    expect(mrpOf(line({ saleUnit: 'box' }))).toBe(12000)
  })

  it('is the chosen batch’s when there is one', () => {
    expect(mrpOf(line({ batchMrp: 1100 }))).toBe(1100)
  })

  it('is nothing for a packet with no MRP', () => {
    expect(mrpOf(line({ mrp: null }))).toBeNull()
    expect(aboveMrp(line({ mrp: null, rate: 99999 }))).toBe(false)
  })

  it('is passed only by a rate above it, and never by a before-tax rate', () => {
    expect(aboveMrp(line({ rate: 1000 }))).toBe(false)
    expect(aboveMrp(line({ rate: 1001 }))).toBe(true)
    expect(aboveMrp(line({ rate: 1001, includesTax: false }))).toBe(false)
  })
})

describe('the MRP column', () => {
  const show = (l: CartLine) => render(
    <CartTable lines={[l]} totals={Totals.computeTotals(totalsLinesOf([l]), 0 as never)} short={new Map()}
      canOverridePrice={false} onEdit={vi.fn()} onRate={vi.fn()} onRemove={vi.fn()} />,
  )

  it('has a heading, and the line’s MRP under it', () => {
    show(line())
    expect(screen.getByText('MRP')).toBeTruthy()
    expect(screen.getByText('10.00').closest('td')?.getAttribute('title')).toBeNull()
  })

  it('says a rate above the MRP', () => {
    show(line({ rate: 1200 }))
    expect(screen.getByTitle('The rate is above the MRP').textContent).toBe('10.00')
  })
})
