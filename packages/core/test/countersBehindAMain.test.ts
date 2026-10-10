import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { claims, ghostClaims, CounterTakenError } from '../src/services/registers.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { setDeviceId } from '../src/device.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Counters in a shop with a main, as the first three-till run found them.
 *
 * Tills 2 and 3 each sync with the main and never with each other. Till 3 was
 * offered the counter till 2 sat at, because a till it had never met read as a
 * ghost; it took it, and both went on issuing BTYW4 numbers -- distinct only
 * because the main relayed each one's latest number within seconds.
 */

const ME = '33333333-3333-4333-8333-333333333333'
const OTHER_TILL = '22222222-2222-4222-8222-222222222222'
const THE_MAIN = '11111111-1111-4111-8111-111111111111'

let fx: Fixture
let product: string

beforeEach(async () => {
  setDeviceId(ME)
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  // This till syncs through a main, and has met nobody else.
  await fx.db.execute(`UPDATE sync_state SET main_device = ?, main_epoch = 1 WHERE id = 1`, [THE_MAIN])
  await fx.db.execute(
    `INSERT INTO sync_peers (device_id, secret, address, created_at) VALUES (?, 's', 'http://10.0.0.1:7801', ?)`,
    [THE_MAIN, new Date().toISOString()],
  )
})
afterEach(async () => {
  setDeviceId(null)
  await fx.db.close()
})

const claimBy = (who: string | null, at: string | null) =>
  fx.db.execute(`UPDATE registers SET claimed_by = ?, claimed_at = ? WHERE id = ?`, [who, at, fx.seed.registerId])

describe('a counter another till sits at, seen from a till behind a main', () => {
  it('is not offered while its claim is fresh, though this till has never met that one', async () => {
    await claimBy(OTHER_TILL, new Date().toISOString())
    expect((await claims(fx.db)).get(fx.seed.registerId)?.stale).toBe(false)
  })

  it('is offered once its claim has gone unrenewed for days, which is the only test left', async () => {
    await claimBy(OTHER_TILL, '2026-01-01T00:00:00Z')
    expect((await claims(fx.db, Date.parse('2026-10-10T00:00:00Z'))).get(fx.seed.registerId)?.stale).toBe(true)
  })

  it('is never listed as a ghost, so one button cannot free every counter in the shop', async () => {
    await claimBy(OTHER_TILL, new Date().toISOString())
    expect(await ghostClaims(fx.db)).toEqual([])
  })
})

describe('on the main, which has met every till', () => {
  it('still reads a till it has never met as a ghost', async () => {
    await fx.db.execute(`UPDATE sync_state SET main_device = ? WHERE id = 1`, [ME])
    await claimBy('a-device-from-a-restored-backup', new Date().toISOString())
    expect((await claims(fx.db)).get(fx.seed.registerId)?.stale).toBe(true)
    expect(await ghostClaims(fx.db)).toHaveLength(1)
  })
})

describe('issuing a bill on a counter', () => {
  const ringUp = async () => {
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)
    return submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
    })
  }

  it('is refused once another till has taken that counter, before a number is minted', async () => {
    // The plan, so this till may bill at all: what is tested is the counter.
    await fx.db.execute(`UPDATE sync_state SET main_device = NULL, main_epoch = 0 WHERE id = 1`)
    await claimBy(OTHER_TILL, new Date().toISOString())
    await expect(ringUp()).rejects.toBeInstanceOf(CounterTakenError)
    const minted = await fx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bills WHERE docstatus = 1`)
    expect(minted?.n).toBe(0)
  })

  it('goes ahead on a counter this till holds, or one nobody has claimed', async () => {
    await fx.db.execute(`UPDATE sync_state SET main_device = NULL, main_epoch = 0 WHERE id = 1`)
    await claimBy(ME, new Date().toISOString())
    expect((await ringUp()).ok).toBe(true)
    await claimBy(null, null)
    expect((await ringUp()).ok).toBe(true)
  })
})
