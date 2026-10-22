import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import {
  migrate, bootstrap, newId, loadFeatures, createDocument, submitDocument, loadDocument, currentStock, Money, Quantity,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* Reached around `@shopos/core` on purpose: see `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'

/**
 * "Receive into stock" on a purchase order opens Stock In with the order's open
 * lines filled in, and posting there puts in what came and marks the order off.
 */

let db: SqlDriver
let seed: BootstrapResult
let paper: string
let adminId: string
let orderId: string
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
const { receiveOrder } = await import('../src/core/nav')

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
  paper = newId()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
     VALUES (?, 'A4 Copier Paper 500 sheets', 34000, 1800, '4802', ?, ?)`,
    [paper, now, now],
  )
  const supplierId = newId()
  await db.execute(
    'INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [supplierId, 'Sakthi Agencies', now, now],
  )
  const po = await createDocument(db, {
    kind: 'purchase_order', registerId: seed.registerId, supplierId,
    lines: [{ productId: paper, qty: Quantity.fromUnits(10), rateOverride: Money.rupees(285) }], actorId: adminId,
  })
  if (!po.ok) throw new Error(po.code)
  await submitDocument(db, { documentId: po.documentId, actorId: adminId })
  orderId = po.documentId

  core = {
    db,
    features: await loadFeatures(db),
    taxScheme: 'regular',
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

describe('receiving a purchase order on Stock In', () => {
  it('fills in the order, takes what came, and leaves the rest open on the order', async () => {
    receiveOrder(orderId)
    render(<StockIn />)

    await screen.findByText(/^Receiving /)
    expect(qtyBox().value).toBe('10')
    expect(screen.getByText('on the order: 10 open')).toBeTruthy()
    expect((document.getElementById('supplier') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Unit cost') as HTMLInputElement).value).toBe('285.00')

    fireEvent.change(qtyBox(), { target: { value: '8' } })
    fireEvent.change(document.getElementById('invoice-no')!, { target: { value: 'SA/2231' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post entry' }))

    await screen.findByText(/still has 1 line open/)
    expect(Quantity.toUnits(await currentStock(db, paper))).toBe(8)
    const after = (await loadDocument(db, orderId))!
    expect(Quantity.toUnits(after.items[0]!.remainingQty)).toBe(2)
    const entry = await db.get<{ supplier_invoice_no: string; reference: string }>(
      'SELECT supplier_invoice_no, reference FROM stock_entries ORDER BY rowid DESC LIMIT 1',
    )
    expect(entry).toEqual({ supplier_invoice_no: 'SA/2231', reference: after.docNo })
  })

  it('refuses more than the order has open, and posts nothing', async () => {
    receiveOrder(orderId)
    render(<StockIn />)
    await screen.findByText(/^Receiving /)

    fireEvent.change(qtyBox(), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post entry' }))

    await screen.findByText(/has only 10 left on/)
    expect(Quantity.toUnits(await currentStock(db, paper))).toBe(0)
  })

  it('lets go of the order and becomes an ordinary entry', async () => {
    receiveOrder(orderId)
    render(<StockIn />)
    await screen.findByText(/^Receiving /)

    fireEvent.click(screen.getByRole('button', { name: 'Not against the order' }))
    await waitFor(() => expect(screen.queryByText(/^Receiving /)).toBeNull())
    expect((document.getElementById('supplier') as HTMLSelectElement).disabled).toBe(false)
  })
})
