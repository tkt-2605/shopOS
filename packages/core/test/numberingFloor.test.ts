import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { nextDocNo, peekDocNo } from '../src/services/numbering.js'
import { postMovement } from '../src/services/stock.js'
import { fromUnits } from '../src/quantity.js'
import { rupees } from '../src/money.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * A counter that is behind the documents in its own database.
 *
 * `doc_sequences` stays on each machine, so a till restored from an older
 * backup, or one that has taken over another till's counter, holds bills its
 * counter has never heard of. Before the floor, the next number it minted was
 * one of those, the UNIQUE on `doc_no` rolled the transaction back with the
 * counter, and every retry failed identically: a till that could not bill.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function sell(product: string) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  return submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
  })
}

describe('a document number', () => {
  it('goes past bills the counter never counted, instead of failing for ever', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(50), taxRateBp: 0 })
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(10), voucherType: 'opening',
        voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    const first = await sell(p)
    const second = await sell(p)
    expect(first.ok && second.ok).toBe(true)

    // The counter as a restored backup would have it: from before both bills.
    await fx.db.execute('DELETE FROM doc_sequences', [])
    // What the screen previews is what it will get.
    expect(await peekDocNo(fx.db, 'bill', 'MR')).toMatch(/\/00003$/)

    const third = await sell(p)
    expect(third.ok).toBe(true)
    if (third.ok && second.ok) {
      expect(third.docNo).toMatch(/\/00003$/)
      expect(third.docNo).not.toBe(second.docNo)
    }
    // And the counter itself moved on with it.
    const again = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', 'MR'))
    expect(again).toMatch(/\/00004$/)
  })
})
