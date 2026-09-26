import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { StockMovement, ProductProfit } from '@shopos/core'

/**
 * The product page, as a shopkeeper reads it.
 *
 * The queries are proved against a real database in
 * `packages/core/test/productHistory.test.ts`. What is asserted here is the
 * part a query cannot be: that a movement with no rate says so instead of
 * printing a zero, that a profit built partly from uncosted sales admits it,
 * and that a negative balance is shown rather than tidied away.
 *
 * Each of those is a place where the honest answer is uglier than the pretty
 * one, which is why they are worth pinning.
 */

let movements: StockMovement[] = []
let profit: ProductProfit = blank()

function blank(over: Partial<ProductProfit> = {}): ProductProfit {
  return {
    qtySold: 0 as never, revenue: 0 as never, cost: 0 as never, margin: 0 as never,
    marginBp: 0, uncostedLines: 0, ...over,
  }
}

function move(over: Partial<StockMovement> = {}): StockMovement {
  return {
    at: '2026-09-19T10:00:00.000Z',
    postingDate: '2026-09-19',
    voucherType: 'stock_entry',
    voucherId: 'v1',
    docNo: 'SMR/2627/00001',
    entryType: 'purchase',
    qtyChange: 100_0000 as never,
    unitCost: 6000 as never,
    value: 600_000 as never,
    balanceQty: 100_0000 as never,
    by: 'ramesh',
    ...over,
  }
}

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  productHistory: async () => movements,
  productProfit: async () => profit,
  productValuation: async () => ({
    qtyOnHand: 100_0000, totalValue: 600_000, averageCost: 6000, lastKnownCost: 6000,
  }),
  listPeers: async () => [],
}))

vi.mock('../src/core/syncLoop', () => ({ onSyncRound: () => () => {} }))

const core = { db: {} }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const { ProductHistory } = await import('../src/ui/ProductHistory')

async function show() {
  render(
    <ProductHistory
      productId="p1" name="A4 Copier Paper" baseUnit="ream" onClose={() => {}}
    />,
  )
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  movements = [move()]
  profit = blank()
})

afterEach(() => cleanup())

describe('a movement the shop never priced', () => {
  it('says there is no rate rather than printing zero', async () => {
    /* A zero in a rate column is a claim that the goods were free. The ledger
       distinguishes "no cost recorded" from "cost of nothing" and the screen
       has to as well, or the one number a shopkeeper would query disappears
       into a column of figures. */
    movements = [move({ unitCost: null, value: null })]
    await show()

    const row = screen.getByText('SMR/2627/00001').closest('tr')
    expect(row?.textContent).toContain('none')
    expect(row?.textContent, 'no rate means no value either').not.toContain('0.00')
  })

  it('shows the rate where there is one', async () => {
    await show()
    expect(document.body.textContent).toContain('60.00')
  })
})

describe('a profit built on sales that were never costed', () => {
  it('admits it rather than presenting the margin plainly', async () => {
    profit = blank({ revenue: 100_000 as never, cost: 0 as never, margin: 100_000 as never, marginBp: 10_000, uncostedLines: 3 })
    await show()

    expect(document.body.textContent).toContain('3 sales of this item left the shelf with no cost')
    expect(document.body.textContent).toContain('higher than the truth')
  })

  it('says it once, in the singular, for a single sale', async () => {
    profit = blank({ revenue: 100_000 as never, margin: 100_000 as never, uncostedLines: 1 })
    await show()
    expect(document.body.textContent).toContain('One sale of this item')
  })

  it('says nothing when every sale carried its cost', async () => {
    profit = blank({ revenue: 100_000 as never, cost: 60_000 as never, margin: 40_000 as never, marginBp: 4000 })
    await show()

    expect(document.body.textContent).not.toContain('no cost recorded')
    expect(document.body.textContent).toContain('40.0%')
  })
})

describe('the balance column', () => {
  it('shows a shelf that went below zero rather than tidying it to nothing', async () => {
    /* A shop can sell what its records say it does not have, which is a
       deliberate decision taken in `domain/valuation.ts` — the counts are wrong
       on day one and a till that refuses the item in the customer's hand gets
       abandoned. A history that clamps the consequence hides the evidence. */
    movements = [move({ voucherType: 'bill', docNo: 'BT1/2627/0004', entryType: null, qtyChange: -20_0000 as never, balanceQty: -5_0000 as never })]
    await show()

    expect(document.body.textContent).toContain('-5')
  })
})

describe('what each row came from', () => {
  it('names the kind of movement in the words the screen that made it uses', async () => {
    movements = [
      move({ entryType: 'wastage', voucherId: 'v2' }),
      move({ voucherType: 'bill', entryType: null, voucherId: 'v3' }),
    ]
    await show()

    expect(screen.getByText('Wastage')).toBeTruthy()
    expect(screen.getByText('Sale')).toBeTruthy()
  })

  it('offers something to read for an item that has never moved', async () => {
    movements = []
    await show()
    expect(document.body.textContent).toContain('never moved')
  })
})
