import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import {
  recordPayment, cancelPayment, customerOutstanding, customerStatement,
  listCustomerPayments, writeOff, recordOpeningBalance, customerAccount,
} from '../src/services/payments.js'
import { salesSummary, grossMargin } from '../src/repos/reports.js'
import { listBills } from '../src/repos/catalog.js'
import { businessDate } from '../src/dates.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * The khata, beyond taking a payment.
 *
 * Three of these were already in the engine and called by nothing, which is how
 * a shop ends up keeping the interesting half of its credit book on paper:
 * settling a chosen bill rather than the oldest, undoing a receipt entered
 * against the wrong person, and giving up on a debt.
 */

let fx: Fixture
let customer: string

beforeEach(async () => {
  fx = await freshDb()
  customer = await makeCustomer(fx.db, 'Anand Stores')
})
afterEach(async () => { await fx.db.close() })

/** A bill put entirely on the khata. */
async function onCredit(amount: Money): Promise<{ billId: string; docNo: string }> {
  const p = await makeProduct(fx.db, { baseRate: amount, taxRateBp: 0 })
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId: p, qtyChange: fromUnits(100), unitCost: rupees(1),
      voucherType: 'opening', voucherId: `o-${Math.random()}`, postingDate: businessDate(),
    })
  })
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    customerId: customer,
    lines: [{ productId: p, qty: fromUnits(1), rateOverride: amount }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'credit', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(done.code)
  return { billId: draft.billId, docNo: done.docNo }
}

describe('clearing one bill rather than the oldest', () => {
  /* A customer settling last Tuesday's bill is not settling the oldest one, and
     telling them it went elsewhere is how arguments start. */
  it('puts the money where it was aimed', async () => {
    const first = await onCredit(rupees(300))
    const second = await onCredit(rupees(500))

    const paid = await recordPayment(fx.db, {
      customerId: customer,
      amount: rupees(500),
      method: 'cash',
      allocations: [{ billId: second.billId, amount: rupees(500) }],
      actorId: fx.adminId,
    })
    expect(paid.ok).toBe(true)

    const open = await customerStatement(fx.db, customer)
    expect(open).toHaveLength(1)
    expect(open[0]?.docNo).toBe(first.docNo)
  })

  it('refuses to put more on a bill than it is owed', async () => {
    const bill = await onCredit(rupees(300))
    const paid = await recordPayment(fx.db, {
      customerId: customer,
      amount: rupees(500),
      method: 'cash',
      allocations: [{ billId: bill.billId, amount: rupees(500) }],
      actorId: fx.adminId,
    })
    expect(paid.ok).toBe(false)
    if (!paid.ok && paid.code === 'OVER_ALLOCATED') expect(paid.due).toBe(rupees(300))
  })
})

describe('undoing a receipt', () => {
  it('puts the debt back', async () => {
    await onCredit(rupees(400))
    const paid = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(400), method: 'cash', actorId: fx.adminId,
    })
    if (!paid.ok) throw new Error(paid.code)
    expect(await customerOutstanding(fx.db, customer)).toBe(0)

    await cancelPayment(fx.db, { paymentId: paid.paymentId, actorId: fx.adminId })
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(400))
  })

  it('can be found in the first place, which it could not before', async () => {
    const bill = await onCredit(rupees(400))
    await recordPayment(fx.db, {
      customerId: customer, amount: rupees(250), method: 'upi', reference: 'UPI ref 88',
      actorId: fx.adminId,
    })

    const history = await listCustomerPayments(fx.db, customer)
    expect(history).toHaveLength(1)
    expect(history[0]?.method).toBe('upi')
    expect(history[0]?.reference).toBe('UPI ref 88')
    // What it settled, so cancelling it can say what goes back on the khata.
    expect(history[0]?.allocatedTo).toEqual([{ docNo: bill.docNo, amount: rupees(250) }])
  })

  it('stays on the list, marked, rather than disappearing', async () => {
    await onCredit(rupees(400))
    const paid = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(400), method: 'cash', actorId: fx.adminId,
    })
    if (!paid.ok) throw new Error(paid.code)
    await cancelPayment(fx.db, { paymentId: paid.paymentId, actorId: fx.adminId })

    const history = await listCustomerPayments(fx.db, customer)
    expect(history).toHaveLength(1)
    expect(history[0]?.docstatus).toBe(2)
  })
})

describe('giving up on a debt', () => {
  it('clears the bill without any money arriving', async () => {
    const bill = await onCredit(rupees(40))
    const off = await writeOff(fx.db, {
      customerId: customer, billId: bill.billId, amount: rupees(40),
      reason: 'Shop closed down', actorId: fx.adminId,
    })
    expect(off.ok).toBe(true)
    expect(await customerOutstanding(fx.db, customer)).toBe(0)
  })

  /* The difference between a debt settled and a debt abandoned is exactly what
     an owner wants to see separately, so it must not look like a receipt. */
  it('is an adjustment, not a receipt, and says why', async () => {
    const bill = await onCredit(rupees(40))
    await writeOff(fx.db, {
      customerId: customer, billId: bill.billId, amount: rupees(40),
      reason: 'Shop closed down', actorId: fx.adminId,
    })

    const history = await listCustomerPayments(fx.db, customer)
    expect(history[0]?.method).toBe('adjustment')
    expect(history[0]?.reference).toBe('Written off')
    expect(history[0]?.notes).toBe('Shop closed down')
  })

  it('is undone the same way a payment is', async () => {
    const bill = await onCredit(rupees(40))
    const off = await writeOff(fx.db, {
      customerId: customer, billId: bill.billId, amount: rupees(40),
      reason: 'Changed my mind', actorId: fx.adminId,
    })
    if (!off.ok) throw new Error(off.code)

    await cancelPayment(fx.db, { paymentId: off.paymentId, actorId: fx.adminId })
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(40))
  })
})

describe('what they owed before ShopOS', () => {
  it('goes onto the khata so payments can settle it', async () => {
    const opened = await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(2500),
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    expect(opened.ok).toBe(true)
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(2500))

    await recordPayment(fx.db, {
      customerId: customer, amount: rupees(1000), method: 'cash', actorId: fx.adminId,
    })
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(1500))
  })

  /* The whole reason it is safe to record this as a bill. Without the mark it
     would show up as a day's takings for goods that were never sold. */
  it('is never counted as something the shop sold', async () => {
    await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(2500),
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })

    const today = businessDate()
    const sales = await salesSummary(fx.db, { from: today, to: today })
    expect(sales.total).toBe(0)
    expect(sales.credit).toBe(0)
    expect(sales.bills).toBe(0)

    const margin = await grossMargin(fx.db, { from: today, to: today })
    expect(margin.revenue).toBe(0)
  })

  it('stays off the bills list, which is a list of sales', async () => {
    await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(2500),
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    expect(await listBills(fx.db, { limit: 50 })).toHaveLength(0)
  })

  it('is refused a second time rather than added to', async () => {
    await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(2500),
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    const again = await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(100),
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('ALREADY_SET')
  })
})

