import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type {
  CustomerProfit, CustomerItem, CustomerAccount, SupplierItem, PurchaseLine,
} from '@shopos/core'

/**
 * The customer and supplier pages, as a shopkeeper reads them.
 *
 * The queries are proved against a real database in
 * `packages/core/test/customerAndSupplierWorth.test.ts`. What is asserted here
 * is what only a screen can get wrong: a rate of zero presented as a price, a
 * margin presented without the sales it could not cost, a trend drawn from one
 * number, and a balance owed shown as a balance held.
 */

let profit: CustomerProfit = noProfit()
let items: CustomerItem[] = []
let account: CustomerAccount = emptyAccount()
let supplied: SupplierItem[] = []
let deliveries: PurchaseLine[] = []

function noProfit(over: Partial<CustomerProfit> = {}): CustomerProfit {
  return {
    bills: 0, revenue: 0 as never, cost: 0 as never, margin: 0 as never,
    marginBp: 0, uncostedLines: 0, ...over,
  }
}

function emptyAccount(over: Partial<CustomerAccount> = {}): CustomerAccount {
  return {
    openingBalance: 0 as never,
    entries: [],
    closingBalance: 0 as never,
    advance: 0 as never,
    totals: { bought: 0 as never, paid: 0 as never, returned: 0 as never },
    ...over,
  }
}

function item(over: Partial<SupplierItem> = {}): SupplierItem {
  return {
    productId: 'p1', name: 'Rice 1kg', qty: 30_0000, spent: 270_000 as never,
    lastRate: 9000 as never, firstRate: 9000 as never,
    lastReceived: '2026-09-19', deliveries: 2, ...over,
  }
}

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  customerProfit: async () => profit,
  customerItems: async () => items,
  customerAccount: async () => account,
  supplierItems: async () => supplied,
  supplierPurchases: async () => deliveries,
  listPeers: async () => [],
}))

vi.mock('../src/core/syncLoop', () => ({ onSyncRound: () => () => {} }))

const core = { db: {} }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const { CustomerWorth } = await import('../src/ui/CustomerWorth')
const { SupplierWorth } = await import('../src/ui/SupplierWorth')

async function settle() {
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  })
}

async function showCustomer() {
  render(<CustomerWorth customerId="c1" name="Priya Traders" code="C0003" onClose={() => {}} />)
  await settle()
}

async function showSupplier() {
  render(<SupplierWorth supplierId="s1" name="Acme Distributors" onClose={() => {}} />)
  await settle()
}

beforeEach(() => {
  profit = noProfit()
  items = []
  account = emptyAccount()
  supplied = []
  deliveries = []
})

afterEach(() => cleanup())

describe('what a customer is worth', () => {
  it('shows the profit beside what they owe, which no screen could say before', async () => {
    profit = noProfit({ bills: 4, revenue: 48_900_00 as never, cost: 36_400_00 as never, margin: 12_500_00 as never, marginBp: 2556 })
    account = emptyAccount({ closingBalance: 4_250_00 as never, totals: { bought: 48_900_00 as never, paid: 44_650_00 as never, returned: 0 as never } })
    await showCustomer()

    expect(document.body.textContent).toContain('25.6%')
    expect(screen.getByText('Owing')).toBeTruthy()
  })

  it('calls a credit balance an advance rather than a debt', async () => {
    /* A customer who has paid ahead is not owing minus two hundred rupees. The
       sign is the whole difference between a debt and a deposit. */
    account = emptyAccount({ closingBalance: -200_00 as never })
    await showCustomer()

    expect(screen.getByText('In advance')).toBeTruthy()
    expect(screen.queryByText('Owing')).toBeNull()
    expect(document.body.textContent, 'and shown as a positive amount').not.toContain('-')
  })

  it('admits the sales it could not cost before presenting a margin', async () => {
    profit = noProfit({ revenue: 10_000 as never, margin: 10_000 as never, marginBp: 10_000, uncostedLines: 2 })
    await showCustomer()

    expect(document.body.textContent).toContain('2 sales to this customer')
    expect(document.body.textContent).toContain('higher than the truth')
  })

  it('has something to say about a customer who has bought nothing', async () => {
    await showCustomer()
    expect(document.body.textContent).toContain('not bought anything yet')
  })
})

describe('what a supplier has been charging', () => {
  it('says how the rate has moved when both ends are known', async () => {
    supplied = [item({ firstRate: 28_500 as never, lastRate: 30_000 as never })]
    await showSupplier()

    expect(document.body.textContent, 'a rise of 5.3%').toContain('5.3%')
    expect(document.body.textContent).toContain('↑')
  })

  it('says nothing about a trend for a single delivery', async () => {
    /* One number is not a direction. An arrow drawn from it is an invention,
       and this is the page somebody checks a supplier's prices against. */
    supplied = [item({ deliveries: 1, firstRate: 30_000 as never, lastRate: 30_000 as never })]
    await showSupplier()

    expect(document.body.textContent).not.toContain('↑')
    expect(document.body.textContent).not.toContain('↓')
  })

  it('calls an unrecorded rate none rather than printing it as free', async () => {
    /* Zero is how a blank cost box is stored on a stock entry line. Printed as
       ₹0.00 it claims the supplier gave the goods away. */
    supplied = [item({ firstRate: 0 as never, lastRate: 0 as never })]
    await showSupplier()

    expect(screen.getAllByText('none').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('₹0.00')
  })

  it('totals what has been spent with them', async () => {
    supplied = [item({ spent: 100_00 as never }), item({ productId: 'p2', name: 'Soap', spent: 50_00 as never })]
    await showSupplier()

    expect(document.body.textContent).toContain('150.00')
  })

  it('has something to say about a supplier nothing has come from', async () => {
    await showSupplier()
    expect(document.body.textContent).toContain('Nothing has been received')
  })
})
