import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import {
  migrate, bootstrap, newId, setSetting, setFeature, setUnits, setLadder, Ladder, Quantity,
  loadFeatures, loadRounding, loadTaxScheme, pricingContextFor, resolveLinePrice,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* The node driver and the permission loader are reached around `@shopos/core`
   on purpose: see `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'

/**
 * The counter, driven the way a cashier drives it, against a real database.
 *
 * Every pricing rule was proved in core and the counter still charged one
 * pack's price for a box of fifty (0.2.3): core tests priced bills through the
 * service, and the screen -- which works the rate out itself and hands it over
 * as already decided -- had no test at all. So this one does what a cashier
 * does and then holds the bill that was stored to what the shop's prices say
 * about each of its lines, worked out separately.
 */

let db: SqlDriver
let seed: BootstrapResult
let core: Record<string, unknown>

vi.mock('../src/core/CoreProvider', () => ({
  useCore: () => core,
  useUser: () => core['user'],
  useDb: () => core['db'],
}))
vi.mock('../src/core/print', () => ({ printBill: async () => ({ ok: true }) }))

const { default: Billing } = await import('../src/pages/Billing')

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'TRT Stationery' })
  await setSetting(db, 'shop_state_code', '33')
  await setSetting(db, 'shop_gstin', '33ALNPJ1906G1ZC')

  const adminId = newId()
  const now = new Date().toISOString()
  const roleId = seed.roleIds['Admin']!
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, roleId, now, now],
  )
  const paper = newId()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
     VALUES (?, 'A4 Copier Paper 500 sheets', 34000, 1200, '4802', ?, ?)`,
    [paper, now, now],
  )
  const ctx = { actorId: adminId }
  await setFeature(db, ctx, 'tieredPricing', true)
  const units = await setUnits(db, ctx, paper, [
    { saleUnit: 'ream', baseUnits: Quantity.fromUnits(10) },
    { saleUnit: 'box', baseUnits: Quantity.fromUnits(50) },
  ])
  if (!units.ok) throw new Error(units.code)
  const rungs = Ladder.rowsToRungs([{ minQty: '10', rate: '335' }, { minQty: '50', rate: '310' }])
  if (!rungs.ok) throw new Error(rungs.code)
  const ladder = await setLadder(db, ctx, {
    productId: paper, priceListId: seed.priceListId, saleUnit: 'piece', rungs: rungs.rungs,
  })
  if (!ladder.ok) throw new Error(ladder.code)

  core = {
    db,
    registerId: seed.registerId,
    stockPolicy: 'allow',
    rounding: await loadRounding(db),
    taxScheme: await loadTaxScheme(db),
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

/** Types into the scan box and takes the first match, as Enter does. */
async function scan(term: string) {
  const box = screen.getByPlaceholderText(/Scan a barcode/)
  fireEvent.change(box, { target: { value: term } })
  await waitFor(() => expect(screen.getAllByText(/A4 Copier Paper/).length).toBeGreaterThan(0))
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(document.querySelector('select.unit-select')).not.toBeNull())
}

/** Takes the money in cash and waits for the bill to be stored. */
async function payCash(): Promise<string> {
  await waitFor(() => expect(screen.getByText('Take payment')).toBeTruthy())
  fireEvent.click(screen.getByText('Take payment'))
  const cash = await screen.findAllByRole('button', { name: /^Cash/ })
  fireEvent.click(cash[0]!)
  let billId = ''
  await waitFor(async () => {
    const row = await db.get<{ id: string }>(`SELECT id FROM bills WHERE docstatus = 1`)
    expect(row).toBeDefined()
    billId = row!.id
  })
  return billId
}

/** The stored bill's lines, each against what the shop's prices say for it. */
async function heldToThePrices(billId: string) {
  const lines = await db.query<{ product_id: string; sale_unit: string; qty: number; rate: number }>(
    `SELECT product_id, sale_unit, qty, rate FROM bill_items WHERE bill_id = ?`, [billId])
  const pricing = await pricingContextFor(db, null)
  return Promise.all(lines.map(async (l) => ({
    unit: l.sale_unit,
    charged: l.rate,
    rule: (await resolveLinePrice(db, pricing, { productId: l.product_id, saleUnit: l.sale_unit, qty: l.qty as never })).rate,
  })))
}

describe('the counter charges what the shop’s prices say', () => {
  it('for a pack switched to a box of fifty', async () => {
    render(<Billing />)
    await scan('A4')
    fireEvent.change(document.querySelector('select.unit-select')!, { target: { value: 'box' } })
    await waitFor(() => expect(document.body.textContent).toContain('15,500.00'))

    const lines = await heldToThePrices(await payCash())
    expect(lines).toEqual([{ unit: 'box', charged: 1_550_000, rule: 1_550_000 }])
  })

  it('for a quantity typed up to the ten-or-more price', async () => {
    render(<Billing />)
    await scan('A4')
    fireEvent.change(document.querySelector('input.qty-input')!, { target: { value: '10' } })
    await waitFor(() => expect(document.body.textContent).toContain('3,350.00'))

    const lines = await heldToThePrices(await payCash())
    expect(lines).toEqual([{ unit: 'piece', charged: 33_500, rule: 33_500 }])
  })

  it('for the same item scanned twice', async () => {
    render(<Billing />)
    await scan('A4')
    await scan('A4')
    await waitFor(() => expect((document.querySelector('input.qty-input') as HTMLInputElement).value).toBe('2'))

    const lines = await heldToThePrices(await payCash())
    expect(lines).toEqual([{ unit: 'piece', charged: 34_000, rule: 34_000 }])
  })
})
