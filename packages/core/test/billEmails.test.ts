import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { createCustomer, updateCustomer, isEmail } from '../src/services/customers.js'
import {
  billsToEmail, billDueForEmail, noteBillEmail, billEmailNote, retryBillEmail, sendsBillEmails, billEmailCustomers,
} from '../src/services/billEmails.js'
import { loadCustomer } from '../src/repos/catalog/customers.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Bills emailed to the customers the shop chooses (073): every bill rung for a
 * ticked customer from the moment of the tick, once, and nobody else's.
 */

let fx: Fixture
let product: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { name: 'Ball pen', baseRate: rupees(10), taxRateBp: 0 })
})
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

async function customer(input: { email?: string | null; emailBills?: boolean } = {}): Promise<string> {
  const saved = await createCustomer(fx.db, ctx(), { name: 'Ravi', ...input })
  if (!saved.ok) throw new Error(saved.code)
  return saved.customerId
}

async function sell(customerId: string | null): Promise<string> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, customerId,
    lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal as Money }], actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(done.code)
  return draft.billId
}

describe('which bills are emailed', () => {
  it('none for a customer nobody ticked, even with an address', async () => {
    await sell(await customer({ email: 'ravi@example.com' }))
    expect(await billsToEmail(fx.db)).toEqual([])
  })

  it('every bill rung for a ticked customer from the tick on, and none from before', async () => {
    const ravi = await customer({ email: 'ravi@example.com' })
    const before = await sell(ravi)
    await new Promise((r) => setTimeout(r, 5))
    const ticked = await updateCustomer(fx.db, ctx(), ravi, { name: 'Ravi', emailBills: true })
    expect(ticked).toMatchObject({ ok: true })
    await new Promise((r) => setTimeout(r, 5))
    const after = await sell(ravi)

    const due = await billsToEmail(fx.db)
    expect(due.map((b) => b.billId)).toEqual([after])
    expect(due.map((b) => b.billId)).not.toContain(before)
    expect(due[0]).toMatchObject({ to: 'ravi@example.com', customerName: 'Ravi' })
  })

  it('a bill once, however often the main looks', async () => {
    const bill = await sell(await customer({ email: 'ravi@example.com', emailBills: true }))
    await noteBillEmail(fx.db, { billId: bill, to: 'ravi@example.com' })
    expect(await billsToEmail(fx.db)).toEqual([])
    expect(await billEmailNote(fx.db, bill)).toMatchObject({ to: 'ravi@example.com', error: null })

    await retryBillEmail(fx.db, bill)
    expect((await billsToEmail(fx.db)).map((b) => b.billId)).toEqual([bill])
  })

  it('stops when the tick is taken off', async () => {
    const ravi = await customer({ email: 'ravi@example.com', emailBills: true })
    await updateCustomer(fx.db, ctx(), ravi, { name: 'Ravi', emailBills: false })
    await sell(ravi)
    expect(await billsToEmail(fx.db)).toEqual([])
  })

  it('says a bill is still due, so the bill can say what it waits for', async () => {
    const due = await sell(await customer({ email: 'ravi@example.com', emailBills: true }))
    const notTicked = await sell(await customer({ email: 'asha@example.com' }))
    expect(await billDueForEmail(fx.db, due)).toBe('ravi@example.com')
    expect(await billDueForEmail(fx.db, notTicked)).toBeNull()
    await noteBillEmail(fx.db, { billId: due, to: 'ravi@example.com' })
    expect(await billDueForEmail(fx.db, due), 'not once it is queued').toBeNull()
  })

  it('is sent by a till on its own', async () => {
    expect(await sendsBillEmails(fx.db)).toBe(true)
  })

  it('counts the customers ticked, for Settings to say', async () => {
    await customer({ email: 'ravi@example.com', emailBills: true })
    await customer({ email: 'asha@example.com' })
    expect(await billEmailCustomers(fx.db)).toBe(1)
  })
})

describe('the customer\'s address', () => {
  it('is kept when a form that does not show it saves the customer', async () => {
    const ravi = await customer({ email: 'ravi@example.com', emailBills: true })
    await updateCustomer(fx.db, ctx(), ravi, { name: 'Ravi K' })
    const saved = await loadCustomer(fx.db, ravi)
    expect(saved?.email).toBe('ravi@example.com')
    expect(saved?.emailBillsSince).not.toBeNull()
  })

  it('a bad one stored before it was checked does not stop the rest being saved', async () => {
    const ravi = await customer()
    await fx.db.execute('UPDATE customers SET email = ? WHERE id = ?', ['not an address', ravi])
    expect(await updateCustomer(fx.db, ctx(), ravi, { name: 'Ravi K' })).toMatchObject({ ok: true })
    expect(await updateCustomer(fx.db, ctx(), ravi, { name: 'Ravi K', emailBills: true }))
      .toEqual({ ok: false, code: 'BAD_EMAIL' })
  })

  it('is needed before bills can be emailed', async () => {
    expect(await createCustomer(fx.db, ctx(), { name: 'Ravi', emailBills: true }))
      .toEqual({ ok: false, code: 'EMAIL_REQUIRED' })
  })

  it('is one plain address and nothing that could add a second', async () => {
    expect(await createCustomer(fx.db, ctx(), { name: 'Ravi', email: 'ravi@example.com, boss@example.com' }))
      .toEqual({ ok: false, code: 'BAD_EMAIL' })
    expect(isEmail('ravi@example.com')).toBe(true)
    expect(isEmail('Ravi <ravi@example.com>')).toBe(false)
    expect(isEmail('ravi@localhost')).toBe(false)
    expect(isEmail('ravi@example.com\r\nBcc: x@y.com')).toBe(false)
  })

  it('taking the address away takes the tick with it', async () => {
    const ravi = await customer({ email: 'ravi@example.com', emailBills: true })
    await updateCustomer(fx.db, ctx(), ravi, { name: 'Ravi', email: null })
    expect((await loadCustomer(fx.db, ravi))?.emailBillsSince).toBeNull()
  })
})
