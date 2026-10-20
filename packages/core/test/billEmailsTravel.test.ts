import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { createCustomer } from '../src/services/customers.js'
import { billsToEmail, noteBillEmail, billEmailNote, retryBillEmail } from '../src/services/billEmails.js'
import { setDeviceId } from '../src/device.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import { TILL_A, TILL_B, as, pull, type Till } from './twoTills.js'

/**
 * A bill is emailed once, whichever till sends it (076). The note of what was
 * emailed travels, so a till that becomes the main -- or a second till that
 * thought it was the main -- does not mail a customer a bill already sent.
 */

let fx: Fixture
let a: Till
let b: Till
let bill = ''

beforeEach(async () => {
  fx = await freshDb()
  a = { id: TILL_A, db: fx.db }
  b = { id: TILL_B, db: await emptyDb() }
  bill = await as(TILL_A, async () => {
    const pen = await makeProduct(a.db, { name: 'Ball pen', baseRate: rupees(10), taxRateBp: 0 })
    const ravi = await createCustomer(a.db, { actorId: fx.adminId }, { name: 'Ravi', email: 'ravi@example.com', emailBills: true })
    if (!ravi.ok) throw new Error(ravi.code)
    await new Promise((r) => setTimeout(r, 5))
    const draft = await createBill(a.db, {
      registerId: fx.seed.registerId, customerId: ravi.customerId,
      lines: [{ productId: pen, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)
    const done = await submitBill(a.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal as Money }], actorId: fx.adminId,
    })
    if (!done.ok) throw new Error(done.code)
    return draft.billId
  })
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

const due = (t: Till) => as(t.id, async () => (await billsToEmail(t.db)).map((x) => x.billId))

describe('the note that a bill was emailed', () => {
  it('reaches the other till, which then does not email that bill', async () => {
    await pull(b, a)
    expect(await due(b)).toEqual([bill])

    await as(TILL_A, () => noteBillEmail(a.db, { billId: bill, to: 'ravi@example.com' }))
    await pull(b, a)
    expect(await due(b)).toEqual([])
    expect(await as(TILL_B, () => billEmailNote(b.db, bill))).toMatchObject({ to: 'ravi@example.com', error: null })
  })

  it('goes the other way too: a bill the second till sent is not sent by the first', async () => {
    await pull(b, a)
    await as(TILL_B, () => noteBillEmail(b.db, { billId: bill, to: 'ravi@example.com' }))
    await pull(a, b)
    expect(await due(a)).toEqual([])
  })

  it('taken away by Try again on one till, is taken away on the other', async () => {
    await as(TILL_A, () => noteBillEmail(a.db, { billId: bill, to: 'ravi@example.com', error: 'no mail set up' }))
    await pull(b, a)
    expect(await due(b)).toEqual([])
    await as(TILL_A, () => retryBillEmail(a.db, bill))
    await pull(b, a)
    expect(await due(b)).toEqual([bill])
  })
})
