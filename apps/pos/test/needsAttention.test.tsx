import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Discrepancy } from '@shopos/core'

/**
 * Being told: the banner on every screen, and the list on the dashboard.
 *
 * What is found is proved against real tills in core
 * (`discrepancies.test.ts`). What is asserted here is the telling: that it
 * shows to someone who can act and not to someone who cannot, that it names
 * the money, that a cleared one leaves the list and can be shown again, and
 * that a shop with nothing wrong is told so rather than shown an empty box.
 */

type Row = Discrepancy & { seen: boolean }
let rows: Row[] = []
const marked: string[][] = []

const refund: Row = {
  key: 'refunded_twice:line-1:20000', kind: 'refunded_twice', area: 'money', seen: false,
  title: 'Shirt was taken back more times than it was sold',
  detail: 'Bill MR/2627/00007 sold 1 piece; 2 came back, on CMR/2627/00001 by Asha, CFC/2627/00001 by Ravi.',
  action: 'Two counters took this return while they could not reach each other.',
  amount: 100000 as never, refs: ['MR/2627/00007', 'CMR/2627/00001', 'CFC/2627/00001'], at: '2026-10-07T10:00:00Z',
}
const below: Row = {
  key: 'sold_below_zero:p1', kind: 'sold_below_zero', area: 'stock', seen: false,
  title: 'Rice 25kg is below zero', detail: 'The shop’s stock of Rice 25kg is -2 piece.',
  action: 'Count it.', amount: null, refs: [], at: null,
}

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  discrepanciesWithSeen: async () => rows,
  markDiscrepanciesSeen: async (_db: unknown, input: { keys: string[] }) => {
    marked.push(input.keys)
    rows = rows.map((r) => (input.keys.includes(r.key) ? { ...r, seen: true } : r))
  },
}))
vi.mock('../src/core/syncLoop', () => ({ onSyncRound: () => () => {} }))
vi.mock('../src/core/log', () => ({ logEvent: () => {} }))
const went: string[] = []
vi.mock('../src/core/nav', () => ({ goTo: (page: string) => { went.push(page) } }))
const core = { db: {} }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core, useUser: () => ({ id: 'u1' }) }))

const { DiscrepancyBanner } = await import('../src/ui/DiscrepancyBanner')
const { NeedsAttention } = await import('../src/ui/NeedsAttention')
const { checkDiscrepancies } = await import('../src/core/discrepancyWatch')

beforeEach(() => { rows = [refund, below]; marked.length = 0; went.length = 0 })
afterEach(async () => {
  cleanup()
  rows = []
  await checkDiscrepancies(core.db as never)
})

describe('the banner', () => {
  it('says how many, the money at stake, and takes the owner to the list', async () => {
    render(<DiscrepancyBanner canReview />)
    await screen.findByText(/2 things in the shop’s records/)
    expect(screen.getByText(/₹1,000\.00 at stake/)).toBeTruthy()
    expect(screen.getByText(/Shirt was taken back more times than it was sold, and 1 more/)).toBeTruthy()
    fireEvent.click(screen.getByText('Review'))
    expect(went).toEqual(['dashboard'])
  })

  it('stays away from someone who cannot open the dashboard', async () => {
    render(<DiscrepancyBanner canReview={false} />)
    await checkDiscrepancies(core.db as never)
    expect(screen.queryByText(/in the shop’s records/)).toBeNull()
  })
})

describe('the list', () => {
  it('shows each with what to do, and takes one cleared off the list', async () => {
    render(<><DiscrepancyBanner canReview /><NeedsAttention /></>)
    await screen.findByText('Rice 25kg is below zero')
    expect(screen.getByText(/CMR\/2627\/00001 · CFC\/2627\/00001/)).toBeTruthy()

    fireEvent.click(screen.getAllByText('Clear')[0]!)
    await waitFor(() => expect(marked).toEqual([[refund.key]]))
    await screen.findByText(/One thing in the shop’s records does not add up/)
    expect(screen.queryByText(refund.title)).toBeNull()

    fireEvent.click(screen.getByText('Show 1 cleared'))
    expect(screen.getByText(refund.title)).toBeTruthy()
    expect(screen.getByText('cleared')).toBeTruthy()
  })

  it('clears them all at once, and says nothing is new', async () => {
    render(<NeedsAttention />)
    await screen.findByText('Rice 25kg is below zero')
    fireEvent.click(screen.getByText('Clear all'))
    await screen.findByText('Nothing new')
    expect(marked).toEqual([[refund.key, below.key]])
    expect(screen.getByText('Show 2 cleared')).toBeTruthy()
  })

  it('says everything adds up when nothing is wrong', async () => {
    rows = []
    render(<NeedsAttention />)
    await screen.findByText('Everything adds up')
  })
})
