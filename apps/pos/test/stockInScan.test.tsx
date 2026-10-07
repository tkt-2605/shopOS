import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import {
  migrate, bootstrap, newId, setBarcodes, loadFeatures, type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* Reached around `@shopos/core` on purpose: see `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'

/**
 * Goods coming in, scanned.
 *
 * The same box as the counter's -- "Scan or search an item to add" -- and the
 * same mistake: Enter took row 0 of the list for the empty box, so a barcode
 * the shop did not have received the first item in the catalog into stock, at
 * whatever the supplier charged.
 */

let db: SqlDriver
let seed: BootstrapResult
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

  const adminId = newId()
  const now = new Date().toISOString()
  const roleId = seed.roleIds['Admin']!
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, roleId, now, now],
  )
  const pen = newId()
  for (const [id, name] of [[newId(), 'A4 Copier Paper 500 sheets'], [pen, 'Ball Pen Blue']] as const) {
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
       VALUES (?, ?, 1000, 1200, '4802', ?, ?)`,
      [id, name, now, now],
    )
  }
  const coded = await setBarcodes(db, { actorId: adminId }, pen, [{ barcode: PEN_BARCODE }])
  if (!coded.ok) throw new Error(coded.code)

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

async function scanFast(code: string) {
  // Let the empty box's list load: that is the list a fast Enter used to read.
  await act(() => new Promise((r) => setTimeout(r, 30)))
  const box = screen.getByPlaceholderText(/Scan or search an item/)
  fireEvent.change(box, { target: { value: code } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

const linesText = () => [...document.querySelectorAll('input.qty-input')]
  .map((input) => input.closest('tr')?.textContent ?? '').join(' | ')

describe('a scanner at stock in', () => {
  it('adds the scanned item', async () => {
    render(<StockIn />)
    await scanFast(PEN_BARCODE)
    await waitFor(() => expect(linesText()).toContain('Ball Pen Blue'))
    expect(linesText()).not.toContain('A4 Copier Paper')
  })

  it('adds nothing for a barcode the shop does not have, and says so', async () => {
    render(<StockIn />)
    await scanFast('4001234567891')
    await waitFor(() => expect(document.body.textContent).toContain('Nothing in the catalog matches 4001234567891.'))
    expect(linesText()).not.toMatch(/A4 Copier Paper|Ball Pen Blue/)
  })
})
