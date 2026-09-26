import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { createReturn, submitReturn } from '../src/services/returns.js'
import { postMovement } from '../src/services/stock.js'
import { setSetting } from '../src/services/bootstrap.js'
import { reconcileLoyalty } from '../src/services/loyaltyLedger.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * A loyalty entry is edited, so it has to merge like something that is edited.
 *
 * It had no revision, so an entry changed on one till lost to the stale copy
 * on whichever till had the higher device id, and a customer's balance stayed
 * different on the two machines for good. Now an edit raises `rev`, and after
 * every merge `consumed` and `cancelled_at` are put back in line with the
 * redemptions and the bill, which both tills agree on.
 */

let fx: Fixture
beforeEach(async () => {
  fx = await freshDb()
  // Five points on every hundred rupees, each point worth a rupee.
  await setSetting(fx.db, 'loyalty_program', JSON.stringify({
    enabled: true,
    tiers: [{ minSpend: 0, pointsPerHundred: 5 }],
    expiryDays: 365,
    pointValue: 100,
    earnOnCreditPortion: false,
    minBillForEarn: 0,
    maxRedeemFractionBp: 10_000,
  }))
})
afterEach(async () => { await fx.db.close() })

async function sale(product: string, customer: string, redeem = 0, units = 2) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, customerId: customer,
    lines: [{ productId: product, qty: fromUnits(units) }], actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const paid = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: (draft.grandTotal - rupees(redeem)) as typeof draft.grandTotal }],
    ...(redeem > 0 ? { redeemPoints: redeem } : {}),
    actorId: fx.adminId,
  })
  if (!paid.ok) throw new Error(paid.code + ' ' + ('reason' in paid ? paid.reason : ''))
  return draft.billId
}

async function entryOf(billId: string) {
  return fx.db.get<{ consumed: number; rev: number; updated_at: string | null; cancelled_at: string | null }>(
    'SELECT consumed, rev, updated_at, cancelled_at FROM loyalty_entries WHERE bill_id = ?', [billId],
  )
}

async function setUp() {
  const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId: p, qtyChange: fromUnits(20), voucherType: 'opening',
      voucherId: newId(), postingDate: '2026-01-01',
    })
  })
  const c = await makeCustomer(fx.db)
  const earned = await sale(p, c)
  return { p, c, earned }
}

describe('a loyalty entry', () => {
  it('raises its revision when it is redeemed from, so the edit wins a merge', async () => {
    const { p, c, earned } = await setUp()
    const before = await entryOf(earned)
    await sale(p, c, 10)
    const after = await entryOf(earned)

    expect(after?.consumed).toBe(10)
    expect(after!.rev).toBeGreaterThan(before!.rev)
    expect(after?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('has its spent points put back in line with the redemptions', async () => {
    const { p, c, earned } = await setUp()
    await sale(p, c, 10)
    // What the losing side of a merge would leave: the redemption arrived, the entry did not move.
    await fx.db.execute('UPDATE loyalty_entries SET consumed = 0 WHERE bill_id = ?', [earned])

    const found = await reconcileLoyalty(fx.db)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ figure: 'consumed', stored: 0, derived: 10, repairable: true })
    expect((await entryOf(earned))?.consumed).toBe(0)  // reported, not yet repaired

    const revBefore = (await entryOf(earned))!.rev
    await reconcileLoyalty(fx.db, { repair: true })
    const repaired = await entryOf(earned)
    expect(repaired?.consumed).toBe(10)
    // Written as a merge is: every till derives the same answer, so nothing is sent.
    expect(repaired?.rev).toBe(revBefore)
    expect(await reconcileLoyalty(fx.db)).toEqual([])
  })

  it('counts two redemptions both, where a merge of the entry would keep only one', async () => {
    const { p, c, earned } = await setUp()
    await sale(p, c, 10)
    await sale(p, c, 5)
    await fx.db.execute('UPDATE loyalty_entries SET consumed = 5 WHERE bill_id = ?', [earned])

    await reconcileLoyalty(fx.db, { repair: true })
    expect((await entryOf(earned))?.consumed).toBe(15)
  })

  it('is marked cancelled when its bill is, whatever the copy that arrived said', async () => {
    const { earned } = await setUp()
    await cancelBill(fx.db, { billId: earned, actorId: fx.adminId })
    await fx.db.execute('UPDATE loyalty_entries SET cancelled_at = NULL WHERE bill_id = ?', [earned])

    await reconcileLoyalty(fx.db, { repair: true })
    expect((await entryOf(earned))?.cancelled_at).not.toBeNull()
  })

  it('leaves a points balance alone when a cancelled redemption gave it back', async () => {
    const { p, c, earned } = await setUp()
    const spent = await sale(p, c, 10)
    await cancelBill(fx.db, { billId: spent, actorId: fx.adminId })

    expect(await reconcileLoyalty(fx.db)).toEqual([])
    expect((await entryOf(earned))?.consumed).toBe(0)
  })

  it('is never given points back, because a bill that spent them may not have arrived', async () => {
    const { p, c, earned } = await setUp()
    await sale(p, c, 10)
    // As if the bill carrying that redemption were still in a later batch.
    await fx.db.execute('UPDATE loyalty_redemptions SET reversed_at = ?', ['2026-01-01T00:00:00.000Z'])

    const found = await reconcileLoyalty(fx.db, { repair: true })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ figure: 'consumed', repairable: false })
    expect((await entryOf(earned))?.consumed).toBe(10)
  })

  it('takes back a clawback that a merge of the entry lost', async () => {
    /* Two partial returns of one bill on two tills each took points off the
       entry; one copy of the entry won and one clawback went with it. The
       returns both arrived, and they say what was taken. */
    const { p, c } = await setUp()
    const earned = await sale(p, c, 0, 4)
    const line = await fx.db.get<{ id: string }>('SELECT id FROM bill_items WHERE bill_id = ?', [earned])
    for (let i = 0; i < 2; i += 1) {
      const ret = await createReturn(fx.db, {
        billId: earned, lines: [{ billItemId: line!.id, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
      })
      if (!ret.ok) throw new Error(ret.code)
      const done = await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
      if (!done.ok) throw new Error(done.code)
    }
    const after = await fx.db.get<{ points: number }>('SELECT points FROM loyalty_entries WHERE bill_id = ?', [earned])
    const removed = await fx.db.query<{ points_removed: number }>(
      'SELECT points_removed FROM sales_returns WHERE bill_id = ? ORDER BY created_at', [earned])
    expect(removed.every((r) => r.points_removed > 0)).toBe(true)
    // The losing copy: only the first of the two clawbacks.
    await fx.db.execute('UPDATE loyalty_entries SET points = points + ? WHERE bill_id = ?', [removed[1]!.points_removed, earned])

    await reconcileLoyalty(fx.db, { repair: true })
    expect((await fx.db.get<{ points: number }>('SELECT points FROM loyalty_entries WHERE bill_id = ?', [earned]))?.points)
      .toBe(after!.points)
  })

  it('never hands points back that a return not yet arrived may have taken', async () => {
    const { earned } = await setUp()
    // Stored points lower than earned, with no return here to say why.
    await fx.db.execute('UPDATE loyalty_entries SET points = points - 5 WHERE bill_id = ?', [earned])
    const found = await reconcileLoyalty(fx.db, { repair: true })
    expect(found).toEqual([expect.objectContaining({ figure: 'points', repairable: false })])
  })
})
