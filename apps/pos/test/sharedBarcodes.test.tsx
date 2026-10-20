import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import {
  migrate, bootstrap, createUser, setBarcodes, listBarcodes, saveProductDetails, Money, type SqlDriver,
} from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'

/**
 * Sorting out codes that were shared before One item per barcode was turned
 * on: Settings lists each with its items and takes it off the one chosen, and
 * Inventory shows each item's latest cost beside its rate.
 */

const core: { db: SqlDriver | null } = { db: null }
const user = { id: '', username: 'owner', fullName: null, roleId: '', roleName: 'Admin', permissions: { resources: { product: { read: true, write: true } } } as never }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core, useUser: () => user }))
const { SharedBarcodes } = await import('../src/pages/settings/SharedBarcodes')
const { useCostHints } = await import('../src/pages/inventory/useCostHints')

let db: SqlDriver
let small: string
let large: string

async function item(name: string): Promise<string> {
  const saved = await saveProductDetails(db, { actorId: user.id }, {
    id: null, name, brand: null, hsnCode: null, taxRateBp: 0, baseRate: Money.rupees(50), mrp: null,
    baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false,
    isStockTracked: true, reorderLevel: null, reorderQty: null,
  })
  if (!saved.ok) throw new Error(saved.code)
  return saved.productId
}

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Test Shop' })
  const made = await createUser(db, { username: 'owner', password: 'right-pass-9', roleId: seed.roleIds['Admin']! })
  if (!made.ok) throw new Error('no user')
  user.id = made.userId
  core.db = db
  small = await item('Glue 50ml')
  large = await item('Glue 100ml')
  await setBarcodes(db, { actorId: user.id }, small, [{ barcode: '8901234567890' }, { barcode: 'TAG-S' }])
  await setBarcodes(db, { actorId: user.id }, large, [{ barcode: '8901234567890' }])
})
afterEach(async () => { cleanup(); await db.close() })

describe('codes on more than one item, in Settings', () => {
  it('lists each code with its items, and takes it off the one chosen after asking', async () => {
    render(<SharedBarcodes />)
    fireEvent.click(await screen.findByLabelText('Take 8901234567890 off Glue 50ml'))
    expect(screen.getByText(/Scanning 8901234567890 will then find Glue 100ml/)).toBeTruthy()
    fireEvent.click(screen.getByText('Take it off'))

    await screen.findByText('8901234567890 is off Glue 50ml.')
    expect((await listBarcodes(db, small)).map((b) => b.barcode)).toEqual(['TAG-S'])
    expect((await listBarcodes(db, large)).map((b) => b.barcode)).toEqual(['8901234567890'])
    expect(screen.queryByText(/still on more than one item/)).toBeNull()
  })

  it('says so when the item is left with no barcode', async () => {
    render(<SharedBarcodes />)
    fireEvent.click(await screen.findByLabelText('Take 8901234567890 off Glue 100ml'))
    fireEvent.click(screen.getByText('Take it off'))
    await screen.findByText(/It has no barcode now, and is found by name/)
    expect(await listBarcodes(db, large)).toEqual([])
  })

  it('changes nothing when the question is answered no', async () => {
    render(<SharedBarcodes />)
    fireEvent.click(await screen.findByLabelText('Take 8901234567890 off Glue 50ml'))
    fireEvent.click(screen.getByText('Keep it on'))
    expect((await listBarcodes(db, small)).map((b) => b.barcode)).toEqual(['8901234567890', 'TAG-S'])
  })

  it('offers no button to somebody who may not edit items', async () => {
    user.permissions = { resources: { product: { read: true } } } as never
    try {
      render(<SharedBarcodes />)
      await screen.findByText(/still on more than one item/)
      expect(screen.queryByText('Take off')).toBeNull()
    } finally {
      user.permissions = { resources: { product: { read: true, write: true } } } as never
    }
  })
})

describe('the latest cost in Inventory', () => {
  it('is the cost price for an item never bought, and nothing for one with neither', async () => {
    await saveProductDetails(db, { actorId: user.id }, {
      id: small, name: 'Glue 50ml', brand: null, hsnCode: null, taxRateBp: 0, baseRate: Money.rupees(50), mrp: null,
      baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false,
      isStockTracked: true, reorderLevel: null, reorderQty: null, costPrice: Money.rupees(31),
    })
    const rows = [{ id: small }, { id: large }]
    const { result } = renderHook(() => useCostHints(db, rows))
    await waitFor(() => expect(result.current.get(small)?.unitCost).toBe(Money.rupees(31)))
    expect(result.current.has(large)).toBe(false)
  })
})
