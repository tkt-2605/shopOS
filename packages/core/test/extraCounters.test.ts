import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, saveDraft } from '../src/services/billing.js'
import { getOrOpenSession } from '../src/services/cash.js'
import { mayTakeMoney, ViewOnlyTillError } from '../src/services/extraCounters.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { setDeviceId } from '../src/device.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'

/**
 * When the plan for several counters ends, the extra counters stop taking
 * money and the main goes on (`licensing-and-accounts.md`, *When paid time
 * ends*; `extraCounters.ts`).
 *
 * The first rule, restated: a licence never stops *the shop* billing. Every
 * test below that refuses a till has a till beside it that still bills.
 */

const ME = '44444444-4444-4444-8444-444444444444'
const THE_MAIN = '55555555-5555-4555-8555-555555555555'

let fx: Fixture
let product: string

beforeEach(async () => {
  setDeviceId(ME)
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
})
afterEach(async () => {
  setDeviceId(null)
  await fx.db.close()
})

const syncsThroughAMain = () =>
  fx.db.execute(`UPDATE sync_state SET main_device = ?, main_epoch = 1 WHERE id = 1`, [THE_MAIN])
const isTheMain = () =>
  fx.db.execute(`UPDATE sync_state SET main_device = ?, main_epoch = 1 WHERE id = 1`, [ME])

const aBill = () => createBill(fx.db, {
  registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
})

describe('an extra till with no plan for several counters', () => {
  it('cannot start a bill', async () => {
    await syncsThroughAMain()
    await expect(aBill()).rejects.toBeInstanceOf(ViewOnlyTillError)
  })

  it('cannot open a drawer', async () => {
    await syncsThroughAMain()
    await expect(getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId }))
      .rejects.toBeInstanceOf(ViewOnlyTillError)
  })

  it('may finish a bill that was already open', async () => {
    const draft = await aBill()
    if (!draft.ok) throw new Error(draft.code)
    await syncsThroughAMain()
    const saved = await saveDraft(fx.db, {
      billId: draft.billId, registerId: fx.seed.registerId,
      lines: [{ productId: product, qty: fromUnits(2) }], actorId: fx.adminId,
    })
    expect(saved.ok).toBe(true)
  })
})

describe('the till that goes on billing', () => {
  it('is the main, with no plan at all', async () => {
    await isTheMain()
    expect((await aBill()).ok).toBe(true)
  })

  it('is a till on its own, which is every one-counter shop', async () => {
    expect((await aBill()).ok).toBe(true)
  })

  it('includes tills paired before there was a main: nobody chose which of them stops', async () => {
    await fx.db.execute(
      `INSERT INTO sync_peers (device_id, secret, created_at) VALUES ('another', 's', ?)`,
      [new Date().toISOString()],
    )
    expect((await aBill()).ok).toBe(true)
  })
})

describe('an extra till, by the state of the plan', () => {
  it('bills while paid, through grace, and stops once grace is over', async () => {
    await syncsThroughAMain()
    const opts = { keys: TEST_KEYS, now: new Date('2026-10-10T06:00:00Z') }

    await licenseTill(fx.db, 'multi', '2026-12-31')
    expect(await mayTakeMoney(fx.db, opts), 'paid').toBe(true)

    await licenseTill(fx.db, 'multi', '2026-10-01')
    expect(await mayTakeMoney(fx.db, opts), 'in grace').toBe(true)

    await licenseTill(fx.db, 'multi', '2020-01-01')
    expect(await mayTakeMoney(fx.db, opts), 'lapsed').toBe(false)

    await licenseTill(fx.db, 'cloud', '2026-12-31')
    expect(await mayTakeMoney(fx.db, opts), 'a renewal, at any tier above, lifts it').toBe(true)

    await licenseTill(fx.db, 'multi', null)
    expect(await mayTakeMoney(fx.db, opts), 'a Business licence, for good').toBe(true)
  })
})
