import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import {
  migrate, bootstrap, newId, loadFeatures, setItemPrice, defaultPriceListId, listItemPrices, createPriceList, Money,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* Reached around `@shopos/core` on purpose: see `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'

/**
 * Special Prices made plain (24 October): one normal price per item, set on
 * the item; price lists chosen first and priced in place; and an item that
 * had two normal prices asked about once.
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

const { default: Pricing } = await import('../src/pages/Pricing')
const { ProductForm } = await import('../src/pages/inventory/ProductForm')
const { BLANK } = await import('../src/pages/inventory/draft')
const { useParentSearch } = await import('../src/pages/inventory/useParentSearch')

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
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at) VALUES (?, 'Ball Pen Black', 1000, 0, ?, ?)`,
    [pen, now, now],
  )
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
  // Loads that started on mount finish before the database they read is closed.
  await new Promise((r) => setTimeout(r, 30))
  cleanup()
  await db.close()
})

describe('Special Prices', () => {
  it('starts with no lists to wade through, and makes one in place', async () => {
    render(<Pricing />)
    await screen.findByText(/No price lists yet/)
    expect(screen.queryByText(/Retail/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New list' }))
    fireEvent.change(screen.getByLabelText('New list name'), { target: { value: 'Wholesale' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add list' }))
    await screen.findByText(/Customers on this list/)
    expect((screen.getByLabelText('Price list') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Wholesale')
  })

  it('shows each item on a list beside its normal price', async () => {
    const made = await createPriceList(db, { actorId: adminId }, { name: 'Wholesale' })
    if (!made.ok) throw new Error(made.code)
    await setItemPrice(db, { actorId: adminId }, { productId: pen, priceListId: made.priceListId, saleUnit: 'piece', rate: Money.rupees(8.5) })

    render(<Pricing />)
    await screen.findByText('Ball Pen Black')
    expect(screen.getByText('₹10.00')).toBeTruthy()
    expect(screen.getByText('₹8.50')).toBeTruthy()
  })

  it('asks once about an item with two normal prices, and keeping the charged one changes the selling rate', async () => {
    const everyone = (await defaultPriceListId(db))!
    await setItemPrice(db, { actorId: adminId }, { productId: pen, priceListId: everyone, saleUnit: 'piece', rate: Money.rupees(9) })

    render(<Pricing />)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose one price each' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ₹9.00' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Choose one price each' })).toBeNull())

    const row = await db.get<{ base_rate: number }>('SELECT base_rate FROM products WHERE id = ?', [pen])
    expect(row!.base_rate).toBe(900)
    expect(await listItemPrices(db, { productId: pen })).toEqual([])
  })
})

describe('the item form', () => {
  function Form({ draft }: { draft: typeof BLANK }) {
    const parent = useParentSearch(db, draft, vi.fn())
    return (
      <ProductForm draft={draft} setDraft={vi.fn()} categories={[]} newCategory="" setNewCategory={vi.fn()}
        onAddCategory={vi.fn()} parentName={undefined} parent={parent} lastCost={null} />
    )
  }

  it('has one normal price: no second price for the shop list', () => {
    render(<Form draft={{ ...BLANK, id: pen, name: 'Ball Pen Black' }} />)
    expect(screen.queryByText(/Price on the shop/)).toBeNull()
    expect(screen.queryByText('Cheaper by the quantity')).toBeNull()
  })

  it('shows the unit on an item that exists, fixed, rather than hiding it', () => {
    render(<Form draft={{ ...BLANK, id: pen, name: 'Ball Pen Black', baseUnit: 'piece' }} />)
    const unit = screen.getByLabelText('Unit') as HTMLInputElement
    expect(unit.value).toBe('piece')
    expect(unit.disabled).toBe(true)
    expect(screen.getByText(/Fixed: stock and bills are counted in it/)).toBeTruthy()
  })

  it('with quantity breaks on, sets them above the selling rate', () => {
    core = { ...core, features: { ...(core['features'] as object), tieredPricing: true } }
    render(<Form draft={{ ...BLANK, id: pen, name: 'Ball Pen Black' }} />)
    expect(screen.getByText('Cheaper by the quantity')).toBeTruthy()
    expect(screen.getByText(/The selling rate above is the price of one/)).toBeTruthy()
  })

  it('says where else the item is priced, and where to change it', async () => {
    const made = await createPriceList(db, { actorId: adminId }, { name: 'Wholesale' })
    if (!made.ok) throw new Error(made.code)
    await setItemPrice(db, { actorId: adminId }, { productId: pen, priceListId: made.priceListId, saleUnit: 'piece', rate: Money.rupees(8.5) })
    render(<Form draft={{ ...BLANK, id: pen, name: 'Ball Pen Black' }} />)
    expect(await screen.findByText(/Also priced: Wholesale ₹8.50\. Change these on Special Prices\./)).toBeTruthy()
  })
})
