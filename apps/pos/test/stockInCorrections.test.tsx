import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react'
import {
  migrate, bootstrap, newId, setBarcodes, loadFeatures, createStockEntry, submitStockEntry, currentStock,
  Money, Quantity, type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* Reached around `@shopos/core` on purpose: see `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'

/**
 * A delivery kept to finish later, and one posted with a mistake in it.
 *
 * Stock In posted the moment it was saved, and a posted entry could not be
 * opened again: a supplier's bill entered with the wrong rate stayed wrong.
 * Now a draft waits under Past entries, Drafts, touching nothing, and a posted
 * entry opens in the form to correct -- saved, it is cancelled and the
 * corrected one posted in its place.
 */

let db: SqlDriver
let seed: BootstrapResult
let pen: string
let adminId: string
let core: Record<string, unknown>

vi.mock('../src/core/CoreProvider', () => ({
  useCore: () => core,
  useUser: () => core['user'],
  useDb: () => core['db'],
}))
vi.mock('../src/core/attachments', () => ({
  storeFile: vi.fn(), readFile: vi.fn(), deleteFile: vi.fn(), filesFromTransfer: () => [], nameFor: () => '',
}))

const { default: StockIn } = await import('../src/pages/StockIn')

const PEN_BARCODE = '8901234567893'

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'TRT Stationery' })
  adminId = newId()
  const now = new Date().toISOString()
  const roleId = seed.roleIds['Admin']!
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, roleId, now, now],
  )
  pen = newId()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
     VALUES (?, 'Ball Pen Blue', 1000, 1200, '9608', ?, ?)`,
    [pen, now, now],
  )
  await setBarcodes(db, { actorId: adminId }, pen, [{ barcode: PEN_BARCODE }])
  core = {
    db,
    features: await loadFeatures(db),
    user: {
      id: adminId, username: 'admin', fullName: 'Administrator', roleId, roleName: 'Admin',
      permissions: await loadPermissions(db, roleId),
    },
  }
})

afterEach(async () => {
  cleanup()
  await db.close()
})

const qtyBox = () => document.querySelector<HTMLInputElement>('table.entry-lines input.qty-input')!
const costBox = () => screen.getByLabelText<HTMLInputElement>('Unit cost')
const entries = () => db.query<{ id: string; docstatus: number; amended_from: string | null }>(
  `SELECT id, docstatus, amended_from FROM stock_entries ORDER BY created_at`)

async function addPen() {
  await act(() => new Promise((r) => setTimeout(r, 30)))
  const box = screen.getByPlaceholderText(/Scan or search an item/)
  fireEvent.change(box, { target: { value: PEN_BARCODE } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(qtyBox()).not.toBeNull())
}

describe('a delivery kept as a draft', () => {
  it('touches nothing until posted, and comes back from Drafts to be finished', async () => {
    render(<StockIn />)
    await addPen()
    fireEvent.change(qtyBox(), { target: { value: '5' } })
    fireEvent.change(costBox(), { target: { value: '4' } })
    fireEvent.click(screen.getByText('Save as draft'))
    await waitFor(() => expect(document.body.textContent).toContain('Saved as a draft'))
    expect(await entries()).toMatchObject([{ docstatus: 0 }])
    expect(await currentStock(db, pen)).toBe(0)

    fireEvent.click(screen.getByText('Past entries'))
    fireEvent.click(await screen.findByRole('button', { name: 'Drafts' }))
    fireEvent.click((await screen.findAllByText('Draft'))[0]!)
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Open to finish'))

    await waitFor(() => expect(document.body.textContent).toContain('Finishing a draft'))
    expect(qtyBox().value).toBe('5')
    expect(costBox().value).toBe('4.00')
    fireEvent.click(screen.getByText('Post entry'))
    await waitFor(() => expect(document.body.textContent).toMatch(/Posted as/))
    expect(await entries()).toMatchObject([{ docstatus: 1 }])
    expect(await currentStock(db, pen)).toBe(Quantity.fromUnits(5))
  })
})

describe('a posted delivery, corrected', () => {
  it('opens in the form, and saved, is cancelled and the corrected one posted in its place', async () => {
    const made = await createStockEntry(db, {
      entryType: 'purchase', actorId: adminId,
      lines: [{ productId: pen, qty: Quantity.fromUnits(10), unitCost: Money.rupees(5), taxRateBp: 1200 }],
    })
    if (!made.ok) throw new Error(made.code)
    const posted = await submitStockEntry(db, { entryId: made.entryId, actorId: adminId })
    if (!posted.ok) throw new Error(posted.code)

    render(<StockIn />)
    fireEvent.click(screen.getByText('Past entries'))
    fireEvent.click(await screen.findByText(posted.docNo))
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Edit'))

    await waitFor(() => expect(document.body.textContent).toContain(`Correcting ${posted.docNo}`))
    expect(qtyBox().value).toBe('10')
    fireEvent.change(costBox(), { target: { value: '6' } })
    fireEvent.click(screen.getByText('Save correction'))

    await waitFor(() => expect(document.body.textContent).toContain(`It corrects ${posted.docNo}`))
    const [old, fixed] = await entries()
    expect(old).toMatchObject({ id: made.entryId, docstatus: 2 })
    expect(fixed).toMatchObject({ docstatus: 1, amended_from: made.entryId })
    expect(await currentStock(db, pen)).toBe(Quantity.fromUnits(10))
  })
})
