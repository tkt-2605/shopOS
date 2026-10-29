import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, ZERO, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { recordPayment, cancelPayment, totalOutstandingAll } from '../src/services/payments.js'
import { postMovement } from '../src/services/stock.js'
import { searchCustomers } from '../src/repos/catalog.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'

/**
 * What the shop is owed, as opposed to what one screenful of customers owes.
 *
 * The range is tested against the twenty-thousand-bill shop in
 * `tools/synthetic-shop`, where "five hundred rows" and "six hundred customers"
 * are different numbers. What is tested here is the *definition*: which bills
 * count, which payments count, which customers count, and what happens to
 * somebody in credit.
 */

let fx: Fixture
let product: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId: product, qtyChange: fromUnits(10_000), voucherType: 'opening',
      voucherId: newId(), postingDate: '2026-01-01',
    })
  })
})
afterEach(async () => { await fx.db.close() })

async function customerWhoBuysOnKhata(): Promise<string> {
  const id = await makeCustomer(fx.db)
  await fx.db.execute(`UPDATE customers SET credit_enforcement = 'none' WHERE id = ?`, [id])
  return id
}

async function creditSale(customerId: string, units: number, postingDate = '2026-02-01'): Promise<string> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    customerId,
    lines: [{ productId: product, qty: fromUnits(units) }],
    postingDate,
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'credit', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(`submit failed: ${done.code}`)
  return draft.billId
}

async function cashSale(customerId: string, units: number): Promise<void> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    customerId,
    lines: [{ productId: product, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(`submit failed: ${done.code}`)
}

describe('what the whole shop is owed', () => {
  it('is nothing on a shop that has sold nothing on credit', async () => {
    const empty = { total: ZERO, customers: 0, worst: null, overLimit: 0 }
    expect(await totalOutstandingAll(fx.db)).toEqual(empty)

    await cashSale(await customerWhoBuysOnKhata(), 5)
    expect(await totalOutstandingAll(fx.db)).toEqual(empty)
  })

  it('adds up every customer who owes, and counts them', async () => {
    const a = await customerWhoBuysOnKhata()
    const b = await customerWhoBuysOnKhata()
    await creditSale(a, 3)
    await creditSale(a, 2)
    await creditSale(b, 7)

    expect(await totalOutstandingAll(fx.db)).toMatchObject({ total: rupees(1200), customers: 2 })
  })

  it('comes down as the khata is settled, and drops the name when it is clear', async () => {
    const a = await customerWhoBuysOnKhata()
    const b = await customerWhoBuysOnKhata()
    await creditSale(a, 3)
    await creditSale(b, 7)

    const taken = await recordPayment(fx.db, {
      customerId: a, amount: rupees(300), method: 'cash', actorId: fx.adminId,
    })
    expect(taken.ok).toBe(true)

    expect(await totalOutstandingAll(fx.db)).toMatchObject({ total: rupees(700), customers: 1 })
  })

  it('puts the debt back when a receipt is cancelled', async () => {
    /* A payment entered against the wrong person is the reason `cancelPayment`
       exists, and the money has to reappear on the khata when it is undone. */
    const a = await customerWhoBuysOnKhata()
    await creditSale(a, 3)
    const taken = await recordPayment(fx.db, {
      customerId: a, amount: rupees(300), method: 'cash', actorId: fx.adminId,
    })
    if (!taken.ok) throw new Error('payment failed')
    expect((await totalOutstandingAll(fx.db)).total).toBe(ZERO)

    await cancelPayment(fx.db, { paymentId: taken.paymentId, actorId: fx.adminId })
    expect(await totalOutstandingAll(fx.db)).toMatchObject({ total: rupees(300), customers: 1 })
  })

  it('forgets a cancelled bill', async () => {
    const a = await customerWhoBuysOnKhata()
    const billId = await creditSale(a, 4)
    await creditSale(a, 1)
    expect((await totalOutstandingAll(fx.db)).total).toBe(rupees(500))

    const gone = await cancelBill(fx.db, { billId, reason: 'Rung up twice', actorId: fx.adminId })
    expect(gone.ok).toBe(true)
    expect(await totalOutstandingAll(fx.db)).toMatchObject({ total: rupees(100), customers: 1 })
  })

  it('leaves out customers no row on the screen would show', async () => {
    /* The headline and the list beneath it have to be the same arithmetic, or
       the page contradicts itself in public. An archived customer's old debt
       appearing in a total but in no row is unanswerable: the shopkeeper can
       see a number and cannot see who it is. */
    const here = await customerWhoBuysOnKhata()
    const archived = await customerWhoBuysOnKhata()
    const deactivated = await customerWhoBuysOnKhata()
    await creditSale(here, 2)
    await creditSale(archived, 5)
    await creditSale(deactivated, 9)

    await fx.db.execute(`UPDATE customers SET deleted_at = ? WHERE id = ?`, ['2026-03-01T00:00:00Z', archived])
    await fx.db.execute(`UPDATE customers SET is_active = 0 WHERE id = ?`, [deactivated])

    const total = await totalOutstandingAll(fx.db)
    expect(total).toMatchObject({ total: rupees(200), customers: 1 })

    const shown = await searchCustomers(fx.db, '', 500)
    expect(shown.reduce<Money>((s, c) => (c.outstanding > 0 ? (s + c.outstanding) as Money : s), ZERO))
      .toBe(total.total)
  })

  it('does not let one customer being in credit pay off another', async () => {
    /* A shop is not owed less because somebody has paid in advance: that money
       still has to be collected from the person who owes it, and netting the
       two off understates the only thing this figure exists to describe.
       `searchCustomers` filters to `outstanding > 0` before the page adds up,
       so this preserves the meaning the screen already had.

       Built by hand because the app's own paths cannot currently reach it —
       `cancelBill` refuses a bill with a payment allocated against it, which is
       the one route to a negative balance. This pins the intended answer for
       the day some other route appears, rather than guarding a live bug. */
    const owes = await customerWhoBuysOnKhata()
    const paidAhead = await customerWhoBuysOnKhata()
    await creditSale(owes, 5)

    const billId = await creditSale(paidAhead, 2)
    const taken = await recordPayment(fx.db, {
      customerId: paidAhead, amount: rupees(200), method: 'cash', actorId: fx.adminId,
    })
    if (!taken.ok) throw new Error('payment failed')
    await fx.db.execute(
      `UPDATE bills SET docstatus = 2, cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
      ['2026-03-01T00:00:00Z', fx.adminId, billId],
    )

    const solo = await searchCustomers(fx.db, '', 500)
    expect(solo.find((c) => c.id === paidAhead)!.outstanding).toBe(-rupees(200))

    expect(await totalOutstandingAll(fx.db)).toMatchObject({ total: rupees(500), customers: 1 })
  })
})

describe('the other two numbers beside it', () => {
  /* They sat next to the total and were computed the same wrong way, off the
     same five hundred rows. Fixing the headline alone would have left two
     thirds of one bug on one screen, looking fixed. */

  it('names the customer to start with, not the worst one on this page', async () => {
    const small = await customerWhoBuysOnKhata()
    const big = await customerWhoBuysOnKhata()
    await fx.db.execute(`UPDATE customers SET name = 'Aarthi' WHERE id = ?`, [small])
    await fx.db.execute(`UPDATE customers SET name = 'Zubeida' WHERE id = ?`, [big])
    await creditSale(small, 2)
    await creditSale(big, 40)

    const seen = await totalOutstandingAll(fx.db)
    expect(seen.worst).toEqual({ id: big, name: 'Zubeida', outstanding: rupees(4000) })
  })

  it('has nobody to name when the book is clear', async () => {
    const a = await customerWhoBuysOnKhata()
    await creditSale(a, 3)
    const taken = await recordPayment(fx.db, {
      customerId: a, amount: rupees(300), method: 'cash', actorId: fx.adminId,
    })
    expect(taken.ok).toBe(true)
    expect((await totalOutstandingAll(fx.db)).worst).toBeNull()
  })

  it('breaks a tie the same way for the name and the figure', async () => {
    /* Two people owing the same amount. The name and the number are separate
       sub-selects, and without a total ordering SQLite is free to answer one
       from each row — one person's name beside another person's debt, on a
       screen used to decide who to telephone. */
    const one = await customerWhoBuysOnKhata()
    const two = await customerWhoBuysOnKhata()
    await fx.db.execute(`UPDATE customers SET name = 'Devi' WHERE id = ?`, [one])
    await fx.db.execute(`UPDATE customers SET name = 'Chandran' WHERE id = ?`, [two])
    await creditSale(one, 6)
    await creditSale(two, 6)

    const seen = await totalOutstandingAll(fx.db)
    expect(seen.worst).toEqual({ id: two, name: 'Chandran', outstanding: rupees(600) })
  })

  it('counts who is past a limit, and nobody who was never given one', async () => {
    const limited = await customerWhoBuysOnKhata()
    const generous = await customerWhoBuysOnKhata()
    const unlimited = await customerWhoBuysOnKhata()
    await fx.db.execute(`UPDATE customers SET credit_limit = ?, credit_enforcement = 'soft' WHERE id = ?`, [rupees(100), limited])
    await fx.db.execute(`UPDATE customers SET credit_limit = ?, credit_enforcement = 'soft' WHERE id = ?`, [rupees(10_000), generous])
    await creditSale(limited, 5)
    await creditSale(generous, 5)
    await creditSale(unlimited, 90)

    /* "No limit" (enforcement none) is never over one, however much is owed. */
    expect((await totalOutstandingAll(fx.db)).overLimit).toBe(1)
  })
})
