import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import {
  migrate, bootstrap, newId, loadFeatures, addVersions, familyVersions, productsByIds,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'
import { resetModalStack } from '../src/core/modalStack'

/**
 * Inventory and an item's page, with a family in the shop: the XO pen in
 * three colours on one barcode, beside an ordinary item.
 *
 * What the owner found confusing is what is held here: a variant listed as an
 * item of its own, and a form that offered to give a variant variants. A
 * family is one row; a variant opens its family; variants are edited on the
 * family's Variants tab and nowhere else.
 */

let db: SqlDriver
let seed: BootstrapResult
let adminId: string
let pen: string
let core: Record<string, unknown>

vi.mock('../src/core/CoreProvider', () => ({
  useCore: () => core,
  useUser: () => core['user'],
  useDb: () => core['db'],
}))
vi.mock('../src/core/attachments', () => ({
  storeFile: vi.fn(), readFile: vi.fn(), deleteFile: vi.fn(), filesFromTransfer: () => [], nameFor: () => '',
}))
vi.mock('../src/core/syncLoop', () => ({ onSyncRound: () => () => {}, runOnce: async () => [] }))

const { default: Inventory } = await import('../src/pages/Inventory')
const { familyRows } = await import('../src/pages/inventory/familyRows')

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'TRT Stationery' })
  adminId = newId()
  const now = new Date().toISOString()
  const roleId = seed.roleIds['Admin']!
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`, [adminId, roleId, now, now],
  )
  pen = newId()
  await db.execute(
    `INSERT INTO products (id, name, barcode, base_rate, tax_rate_bp, created_at, updated_at)
     VALUES (?, 'XO pen', '8901234567890', 1000, 1800, ?, ?)`, [pen, now, now],
  )
  await db.execute('INSERT INTO product_barcodes (id, product_id, barcode, is_primary, created_at) VALUES (?, ?, ?, 1, ?)',
    [newId(), pen, '8901234567890', now])
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
     VALUES (?, 'A4 Copier Paper', 34000, 1800, ?, ?)`, [newId(), now, now],
  )
  const made = await addVersions(db, { actorId: adminId }, { parentId: pen, labels: ['Blue', 'Black', 'Red'] })
  if (!made.ok) throw new Error(made.code)
  core = {
    db, features: await loadFeatures(db), taxScheme: 'regular',
    user: { id: adminId, username: 'admin', fullName: 'Administrator', roleId, roleName: 'Admin', permissions: await loadPermissions(db, roleId) },
  }
})

afterEach(async () => { cleanup(); resetModalStack(); await db.close() })

const rowOf = (text: string) => screen.getByText(text, { selector: 'td *, td' }).closest('tr') as HTMLElement

describe('the Inventory list', () => {
  it('shows the family as one row, and its variants only when opened', async () => {
    render(<Inventory />)
    const family = await waitFor(() => rowOf('XO pen'))
    expect(within(family).getByText('3 variants')).toBeTruthy()
    expect(screen.queryByText('Blue')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open the variants of XO pen' }))
    expect(screen.getByText('Blue')).toBeTruthy()
    expect(screen.queryByText('XO pen (Blue)')).toBeNull()
  })

  it('opens a searched-for variant under its family, marked', () => {
    const blue = { id: 'b', parentProductId: 'p', name: 'XO pen (Blue)', variantLabel: 'Blue' } as never
    const family = { id: 'p', parentProductId: null, name: 'XO pen' } as never
    const [row] = familyRows([blue], [family], true)
    expect(row?.item).toBe(family)
    expect([...row!.marked]).toEqual(['b'])
  })
})

describe("an item's page", () => {
  it('opens a variant as its family, on the Variants tab, with no way to give a variant variants', async () => {
    render(<Inventory />)
    await waitFor(() => rowOf('XO pen'))
    fireEvent.click(screen.getByRole('button', { name: 'Open the variants of XO pen' }))
    fireEvent.click(within(rowOf('Black')).getByRole('button', { name: 'Open' }))

    expect(await screen.findByRole('tab', { name: /Variants/, selected: true })).toBeTruthy()
    expect(screen.getByText('XO pen', { selector: 'div' })).toBeTruthy()
    expect((screen.getByLabelText('Name of Black') as HTMLInputElement).closest('tr')?.getAttribute('style')).toContain('accent-soft')
    expect(screen.queryByText(/Version of/)).toBeNull()
  })

  it('renames a variant from the table, and the item it is follows', async () => {
    render(<Inventory />)
    await waitFor(() => rowOf('XO pen'))
    fireEvent.click(within(rowOf('XO pen')).getByRole('button', { name: 'Open' }))
    fireEvent.click(await screen.findByRole('tab', { name: /Variants/ }))
    const box = await screen.findByLabelText('Name of Red')
    fireEvent.change(box, { target: { value: 'Green' } })
    fireEvent.blur(box)

    await waitFor(async () => {
      const names = (await familyVersions(db, pen)).map((v) => v.name)
      expect(names).toContain('XO pen (Green)')
    })
  })

  it('keeps a page message on the page, in red when nothing was saved', async () => {
    render(<Inventory />)
    await waitFor(() => rowOf('A4 Copier Paper'))
    fireEvent.click(within(rowOf('A4 Copier Paper')).getByRole('button', { name: 'Open' }))
    fireEvent.click(await screen.findByRole('tab', { name: /Price/ }))
    fireEvent.change(document.getElementById('p-mrp') ?? screen.getByLabelText(/MRP/), { target: { value: 'twelve' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Nothing was saved/)
    expect((await productsByIds(db, [pen]))[0]?.name).toBe('XO pen')
  })
})
