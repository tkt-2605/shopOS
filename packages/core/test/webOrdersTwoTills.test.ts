import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { documentToCart } from '../src/services/convert.js'
import { ensureOwnRegister } from '../src/services/registers.js'
import { setSetting } from '../src/services/bootstrap.js'
import { setDeviceId } from '../src/device.js'
import { rupees, type Money } from '../src/money.js'
import { newId } from '../src/ids.js'
import { WEB_SETTINGS, whyNotServing } from '../src/services/web/gate.js'
import { signIn, saveContact, verifyPhone, loadAccount } from '../src/services/web/accounts.js'
import { placeOrder, acceptWebOrder, rejectWebOrder, markWebOrder } from '../src/services/web/orders.js'
import { loadWebOrder } from '../src/services/web/orderViews.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import { as, pull, type Till } from './twoTills.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import { useLicenceKeys } from '../src/services/licence.js'
import { LICENCE_KEYS } from '../src/config/licensing.js'

/**
 * A web order across two tills: taken and accepted on the main, which is the
 * only till that answers the storefront, billed at another counter, and read
 * as collected on the main once the bill has synced back -- with the phone
 * checked at that other counter showing on the main too.
 */

const MAIN = '11111111-1111-4111-8111-111111111111'
const COUNTER = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-28T06:30:00Z')

let fx: Fixture
let main: Till
let counter: Till
let pen: string

beforeEach(async () => {
  fx = await freshDb()
  main = { id: MAIN, db: fx.db }
  counter = { id: COUNTER, db: await emptyDb() }
  const at = NOW.toISOString()
  const stationery = newId()
  await main.db.execute(`INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, 'Stationery', ?, ?)`, [stationery, at, at])
  pen = await makeProduct(main.db, { name: 'Pen', baseRate: rupees(20), taxRateBp: 0 })
  await main.db.execute(`UPDATE products SET category_id = ? WHERE id = ?`, [stationery, pen])
  await setSetting(main.db, 'shop_id', '01a122eb-d2b5-7814-b629-c86ad9bb71ed')
  await setSetting(main.db, WEB_SETTINGS.enabled, 'on')
  await setSetting(main.db, WEB_SETTINGS.open, 'on')
  await setSetting(main.db, WEB_SETTINGS.categories, JSON.stringify([stationery]))
  /* A shop with two counters holds the plan for them; without it the second
     till is view-only (`extraCounters.ts`), which is not what this is about. */
  useLicenceKeys(TEST_KEYS)
  await licenseTill(main.db, 'multi')
  for (const t of [main, counter]) {
    await t.db.execute(`UPDATE sync_state SET main_device = ?, main_epoch = 1 WHERE id = 1`, [MAIN])
  }
  await pull(counter, main)
})

afterEach(async () => {
  useLicenceKeys(LICENCE_KEYS)
  setDeviceId(null)
  for (const t of [main, counter]) await t.db.close()
})

describe('a web order across two tills', () => {
  it('is answered only by the main, billed at another counter, and collected on both', async () => {
    expect(await as(MAIN, () => whyNotServing(main.db))).toBeNull()
    expect(await as(COUNTER, () => whyNotServing(counter.db))).toBe('NOT_THE_MAIN')

    const { orderId, documentId, accountId } = await as(MAIN, async () => {
      const account = await signIn(main.db, { sub: 'g-1', email: 'asha@example.com', name: 'Asha' }, NOW)
      await saveContact(main.db, account.id, { name: 'Asha', phone: '9876543210' }, NOW)
      const placed = await placeOrder(main.db, {
        accountId: account.id, clientOrderId: 'order-two-tills', lines: [{ productId: pen, unit: 'piece', qty: 3, price: 2000 }],
      }, NOW)
      if (!placed.ok) throw new Error(placed.code)
      const accepted = await acceptWebOrder(main.db, {
        webOrderId: placed.order.id, actorId: fx.adminId, registerId: fx.seed.registerId, now: NOW,
      })
      if (!accepted.ok) throw new Error(accepted.code)
      return { orderId: placed.order.id, documentId: accepted.documentId, accountId: account.id }
    })

    await pull(counter, main)
    expect((await loadWebOrder(counter.db, orderId))?.status).toBe('accepted')

    /* Only the main answers: a second till that could would be a second sales order. */
    await as(COUNTER, async () => {
      expect(await markWebOrder(counter.db, { webOrderId: orderId, actorId: fx.adminId, to: 'ready' }))
        .toEqual({ ok: false, code: 'NOT_THE_MAIN' })
      expect(await rejectWebOrder(counter.db, { webOrderId: orderId, actorId: fx.adminId, reason: 'No' }))
        .toEqual({ ok: false, code: 'NOT_THE_MAIN' })
    })

    await as(COUNTER, async () => {
      const registerId = (await ensureOwnRegister(counter.db))!
      const loaded = await documentToCart(counter.db, { documentId })
      if (!loaded.ok) throw new Error(loaded.code)
      const bill = await createBill(counter.db, {
        registerId, customerId: loaded.customerId, convertedFrom: loaded.documentId,
        lines: loaded.lines.map((l) => ({
          productId: l.productId, saleUnit: l.saleUnit, qty: l.qty,
          resolved: { rate: l.rate, source: 'order_rate' as const, sourceId: loaded.documentId },
        })),
        actorId: fx.adminId,
      })
      if (!bill.ok) throw new Error(bill.code)
      const paid = await submitBill(counter.db, { billId: bill.billId, payments: [{ method: 'cash', amount: bill.grandTotal as Money }], actorId: fx.adminId })
      if (!paid.ok) throw new Error(paid.code)
      expect(await verifyPhone(counter.db, { accountId, actorId: fx.adminId })).toEqual({ ok: true })
    })
    expect((await loadWebOrder(counter.db, orderId))?.status).toBe('collected')

    await pull(counter, main)
    expect((await loadWebOrder(main.db, orderId))?.status).toBe('collected')
    expect((await loadAccount(main.db, accountId))?.phoneVerified).toBe(true)
  })
})
