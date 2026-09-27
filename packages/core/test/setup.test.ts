import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shopProgress, setupHidden, hideSetup } from '../src/services/setup.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { setTaxScheme } from '../src/services/features.js'
import { setSetting, forgetSetting } from '../src/services/settings.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * The Getting started list: each step is done when the shop has done it,
 * however it was done, and never because somebody ticked a box.
 */

let fx: Fixture

beforeEach(async () => {
  fx = await freshDb()
  // The fixture is a registered shop in a state; a new shop is neither.
  await forgetSetting(fx.db, 'shop_state_code')
})
afterEach(async () => { await fx.db.close() })

describe('a shop that has just been set up', () => {
  it('has done nothing but exist', async () => {
    expect(await shopProgress(fx.db)).toEqual({
      shopDetails: false, taxScheme: false, items: false, openingStock: false, staff: false, firstBill: false,
    })
  })
})

describe('each step', () => {
  it('needs both an address and a state for the shop details', async () => {
    await setSetting(fx.db, 'shop_address', '12 Main Road, Perambalur')
    expect((await shopProgress(fx.db)).shopDetails, 'an address alone taxes every sale as local').toBe(false)
    await setSetting(fx.db, 'shop_state_code', '33')
    expect((await shopProgress(fx.db)).shopDetails).toBe(true)
  })

  it('counts the tax question as answered only when a person answered it', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'regular')
    expect((await shopProgress(fx.db)).taxScheme).toBe(true)
  })

  it('follows the items, the stock, a second login and the first bill', async () => {
    const product = await makeProduct(fx.db, { baseRate: rupees(20), taxRateBp: 0 })
    const entry = await createStockEntry(fx.db, {
      entryType: 'opening', lines: [{ productId: product, qty: fromUnits(5), unitCost: rupees(10) }], actorId: fx.adminId,
    })
    if (!entry.ok) throw new Error(entry.code)
    await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })

    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
       VALUES (?, 'ravi', 'Ravi', ?, 'x', ?, ?)`,
      [newId(), fx.seed.roleIds['Admin']!, now, now],
    )

    await setSetting(fx.db, 'shop_state_code', '33')
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)
    const paid = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
    })
    if (!paid.ok) throw new Error(paid.code)

    expect(await shopProgress(fx.db)).toMatchObject({ items: true, openingStock: true, staff: true, firstBill: true })
  })

  it('does not count a bill still being rung up', async () => {
    const product = await makeProduct(fx.db)
    await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    expect((await shopProgress(fx.db)).firstBill).toBe(false)
  })
})

describe('putting the list away', () => {
  it('is remembered, and can be undone', async () => {
    expect(await setupHidden(fx.db)).toBe(false)
    await hideSetup(fx.db, true)
    expect(await setupHidden(fx.db)).toBe(true)
    await hideSetup(fx.db, false)
    expect(await setupHidden(fx.db)).toBe(false)
  })
})
