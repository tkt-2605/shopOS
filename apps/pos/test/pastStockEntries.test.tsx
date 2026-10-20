import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import {
  migrate, bootstrap, createUser, createStockEntry, submitStockEntry, Money, Quantity,
  type SqlDriver, type StockEntryType,
} from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { makeProduct } from '../../../packages/core/test/helpers'

/**
 * Past entries on the Stock In page: every entry in one list, narrowed by kind
 * and by a word, and each opened to show its lines.
 */

const core: { db: SqlDriver | null } = { db: null }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))
const { PastEntries, StockInViews } = await import('../src/pages/stockIn/PastEntries')

let db: SqlDriver
let adminId = ''

async function entry(entryType: StockEntryType, productId: string, units: number, unitCost: number, reference = '') {
  const made = await createStockEntry(db, {
    entryType, reference, actorId: adminId,
    lines: [{ productId, qty: Quantity.fromUnits(units), unitCost: unitCost as Money.Money, taxRateBp: 0 }],
  })
  if (!made.ok) throw new Error(made.code)
  const done = await submitStockEntry(db, { entryId: made.entryId, actorId: adminId })
  if (!done.ok) throw new Error(done.code)
}

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Test Shop' })
  const made = await createUser(db, { username: 'owner', password: 'right-pass-9', roleId: seed.roleIds['Admin']! })
  if (!made.ok) throw new Error('no user')
  adminId = made.userId
  core.db = db
  const paper = await makeProduct(db, { name: 'A4 Copier Paper', taxRateBp: 0 })
  const tape = await makeProduct(db, { name: 'Binding Tape', taxRateBp: 0 })
  await entry('purchase', paper, 10, 25000, 'delivery one')
  await entry('opening', tape, 20, 2800)
})
afterEach(async () => { cleanup(); await db.close() })

const bodyRows = () => screen.getAllByRole('row').filter((r) => r.closest('tbody'))

describe('past stock entries', () => {
  it('lists this month’s entries and narrows them by kind and by a word', async () => {
    render(<PastEntries />)
    await waitFor(() => expect(bodyRows()).toHaveLength(2))
    expect(screen.getByText('2 entries')).toBeTruthy()

    fireEvent.click(screen.getByText('Opening stock', { selector: 'button' }))
    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    expect(within(bodyRows()[0]!).getByText('Binding Tape')).toBeTruthy()

    fireEvent.click(screen.getAllByText('All', { selector: 'button' })[0]!)
    fireEvent.change(screen.getByLabelText('Search stock entries'), { target: { value: 'copier' } })
    await waitFor(() => expect(bodyRows().map((r) => r.textContent?.includes('A4 Copier Paper'))).toEqual([true]))
  })

  it('opens an entry to show its lines', async () => {
    render(<PastEntries />)
    await waitFor(() => expect(bodyRows()).toHaveLength(2))
    fireEvent.click(within(bodyRows().find((r) => r.textContent?.includes('A4 Copier Paper'))!).getByText('A4 Copier Paper'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/^Purchase /)).toBeTruthy()
    expect(within(dialog).getByText('10 piece')).toBeTruthy()
    expect(within(dialog).getByText('delivery one')).toBeTruthy()
  })

  it('keeps the new entry being typed while the list is looked at', () => {
    render(<StockInViews newEntry={<input aria-label="typing" defaultValue="half done" />} />)
    fireEvent.click(screen.getByText('Past entries'))
    fireEvent.click(screen.getByText('New entry'))
    expect((screen.getByLabelText('typing') as HTMLInputElement).value).toBe('half done')
  })
})
