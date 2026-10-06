import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, saveDraft, submitBill, amendBill } from '../src/services/billing.js'
import { cancelBill } from '../src/services/billing/cancel.js'
import { setFeature } from '../src/services/features.js'
import { setUnits, setLadder, setItemPrice } from '../src/services/pricing.js'
import { rowsToRungs } from '../src/domain/ladder.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import type { BillLineInput } from '../src/services/billing/types.js'

/**
 * A rate the counter says came from the shop's prices is held to them.
 *
 * The counter works a line's rate out itself and sends it as already resolved,
 * and until 0.2.3 it never worked it out again: a pack of paper switched to a
 * box of fifty went on saying one pack's price, and the bill charged it,
 * because nothing here checked. The screen is fixed (`linePricing.test.ts`);
 * this is so the next screen bug of its kind is a bill refused rather than a
 * bill undercharged.
 */

let fx: Fixture
let paper: string

beforeEach(async () => {
  fx = await freshDb()
  const ctx = { actorId: fx.adminId }
  paper = await makeProduct(fx.db, { name: 'A4 Copier Paper', baseRate: rupees(340), taxRateBp: 1200 })
  await setFeature(fx.db, ctx, 'tieredPricing', true)
  const units = await setUnits(fx.db, ctx, paper, [
    { saleUnit: 'ream', baseUnits: fromUnits(10) }, { saleUnit: 'box', baseUnits: fromUnits(50) },
  ])
  if (!units.ok) throw new Error(units.code)
  const rungs = rowsToRungs([{ minQty: '10', rate: '335' }, { minQty: '50', rate: '310' }])
  if (!rungs.ok) throw new Error(rungs.code)
  const ladder = await setLadder(fx.db, ctx, { productId: paper, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs.rungs })
  if (!ladder.ok) throw new Error(ladder.code)
})
afterEach(async () => { await fx.db.close() })

/** A line as the counter sends it: the rate it worked out, said to be the base price or the list's. */
const asResolved = (saleUnit: string, units: number, rate: Money, source: 'base_rate' | 'default_list' = 'default_list'): BillLineInput => ({
  productId: paper, saleUnit, qty: fromUnits(units),
  resolved: { rate, source, sourceId: null, includesTax: true },
})

const draft = (lines: BillLineInput[]) =>
  createBill(fx.db, { registerId: fx.seed.registerId, lines, actorId: fx.adminId })

describe('a resolved rate is held to the shop’s prices', () => {
  it('refuses one pack’s price on a box of fifty', async () => {
    const made = await draft([asResolved('box', 1, rupees(340), 'base_rate')])
    expect(made).toMatchObject({ ok: false, code: 'RATE_NOT_THE_RULE', rate: rupees(340), rule: rupees(15_500) })
  })

  it('takes the rate the rules give, for the unit and the quantity', async () => {
    expect((await draft([asResolved('box', 1, rupees(15_500))])).ok).toBe(true)
    expect((await draft([asResolved('piece', 10, rupees(335))])).ok).toBe(true)
    expect((await draft([asResolved('piece', 1, rupees(340), 'base_rate')])).ok).toBe(true)
  })

  it('lets a held bill keep the rate it was held at after the list changes', async () => {
    const made = await draft([asResolved('box', 1, rupees(15_500))])
    if (!made.ok) throw new Error(made.code)
    // Fifty or more goes up to ₹320 overnight.
    await setItemPrice(fx.db, { actorId: fx.adminId }, {
      productId: paper, priceListId: fx.seed.priceListId, saleUnit: 'piece', minQty: fromUnits(50), rate: rupees(320),
    })

    const resumed = await saveDraft(fx.db, {
      billId: made.billId, registerId: fx.seed.registerId, lines: [asResolved('box', 1, rupees(15_500))], actorId: fx.adminId,
    })
    expect(resumed.ok).toBe(true)

    // Changed, it is priced as it is now.
    const changed = await saveDraft(fx.db, {
      billId: made.billId, registerId: fx.seed.registerId, lines: [asResolved('box', 2, rupees(15_500))], actorId: fx.adminId,
    })
    expect(changed).toMatchObject({ ok: false, code: 'RATE_NOT_THE_RULE', rule: rupees(16_000) })
  })

  it('leaves a typed rate to the permission that guards it', async () => {
    const typed = await draft([{ productId: paper, saleUnit: 'box', qty: fromUnits(1), rateOverride: rupees(340) }])
    expect(typed.ok).toBe(true)
  })

  it('leaves an order’s promised rate alone', async () => {
    const promised = await draft([{
      productId: paper, saleUnit: 'box', qty: fromUnits(1),
      resolved: { rate: rupees(14_000), source: 'order_rate', sourceId: null, includesTax: true },
    }])
    expect(promised.ok).toBe(true)
  })

  it('lets an amendment carry its original’s rates after the list changes', async () => {
    const made = await draft([asResolved('box', 1, rupees(15_500))])
    if (!made.ok) throw new Error(made.code)
    const paid = await submitBill(fx.db, {
      billId: made.billId, payments: [{ method: 'cash', amount: made.grandTotal }], actorId: fx.adminId,
    })
    if (!paid.ok) throw new Error(paid.code)
    await setItemPrice(fx.db, { actorId: fx.adminId }, {
      productId: paper, priceListId: fx.seed.priceListId, saleUnit: 'piece', minQty: fromUnits(50), rate: rupees(320),
    })
    const cancelled = await cancelBill(fx.db, { billId: made.billId, actorId: fx.adminId })
    if (!cancelled.ok) throw new Error(cancelled.code)

    const amended = await amendBill(fx.db, { billId: made.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
  })
})
