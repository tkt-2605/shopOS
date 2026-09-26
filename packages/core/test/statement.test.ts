import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import { processReturn } from '../src/services/returns.js'
import {
  recordPayment, cancelPayment, customerOutstanding, customerAccount,
  writeOff, recordOpeningBalance,
} from '../src/services/payments.js'
import { businessDate } from '../src/dates.js'
import { freshDb, makeProduct, makeCustomer, type Fixture, editingSubmitted } from './helpers.js'

/**
 * The page a customer takes away.
 *
 * The ledger this replaced listed only what had been put on credit, so a
 * customer who paid cash for eleven months appeared to have bought nothing.
 * A statement has to show everything and still end on a balance that means one
 * thing, which is the whole difficulty.
 */

let fx: Fixture
let customer: string
let product: string

beforeEach(async () => {
  fx = await freshDb()
  customer = await makeCustomer(fx.db, 'Anand Stores')
  product = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100), taxRateBp: 0 })
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId: product, qtyChange: fromUnits(500), unitCost: rupees(40),
      voucherType: 'opening', voucherId: 'o-1', postingDate: businessDate(),
    })
  })
})
afterEach(async () => { await fx.db.close() })

/** One bill, settled however the caller says. */
async function buy(
  units: number,
  method: 'cash' | 'upi' | 'card' | 'credit',
): Promise<{ billId: string; docNo: string; total: Money }> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    customerId: customer,
    lines: [{ productId: product, qty: fromUnits(units), rateOverride: rupees(100) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method, amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(done.code)
  return { billId: draft.billId, docNo: done.docNo, total: draft.grandTotal }
}

const kinds = (a: { entries: { kind: string }[] }) => a.entries.map((e) => e.kind)

describe('what appears on it', () => {
  /* The complaint that prompted this: a customer who pays cash has bought
     nothing, as far as the old ledger was concerned. */
  it('shows a purchase that was paid for in cash', async () => {
    const bill = await buy(3, 'cash')
    const account = await customerAccount(fx.db, customer)

    expect(kinds(account)).toEqual(['bill', 'counter'])
    expect(account.entries[0]?.docNo).toBe(bill.docNo)
    expect(account.entries[0]?.debit).toBe(rupees(300))
    expect(account.entries[1]?.credit).toBe(rupees(300))
  })

  /* Shown in full and then paid off on the same day, so the balance can be read
     at any row rather than only at the bottom. */
  it('leaves the balance where it was, because nothing is owed on it', async () => {
    await buy(3, 'cash')
    const account = await customerAccount(fx.db, customer)
    expect(account.closingBalance).toBe(0)
    expect(account.totals.bought).toBe(rupees(300))
    expect(account.totals.paid).toBe(rupees(300))
  })

  it('puts a bill on the account when it was taken on credit', async () => {
    await buy(3, 'credit')
    const account = await customerAccount(fx.db, customer)
    expect(kinds(account)).toEqual(['bill'])
    expect(account.closingBalance).toBe(rupees(300))
  })

  it('shows what was already owed before the shop started using this', async () => {
    await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(1000), asOf: '2026-01-01',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    const account = await customerAccount(fx.db, customer)
    expect(account.entries[0]?.kind).toBe('opening')
    expect(account.entries[0]?.description).toBe('Balance brought forward')
  })

  it('shows a payment made later, and what it was', async () => {
    await buy(5, 'credit')
    await recordPayment(fx.db, {
      customerId: customer, amount: rupees(200), method: 'upi', actorId: fx.adminId,
    })
    const account = await customerAccount(fx.db, customer)
    const receipt = account.entries.find((e) => e.kind === 'receipt')
    expect(receipt?.description).toBe('Payment — UPI')
    expect(receipt?.credit).toBe(rupees(200))
    expect(account.closingBalance).toBe(rupees(300))
  })

  it('shows a debt that was given up on, named as that', async () => {
    const bill = await buy(1, 'credit')
    await writeOff(fx.db, {
      customerId: customer, billId: bill.billId, amount: rupees(100),
      reason: 'Moved away', actorId: fx.adminId,
    })
    const account = await customerAccount(fx.db, customer)
    expect(account.entries.some((e) => e.kind === 'writeoff')).toBe(true)
    expect(account.closingBalance).toBe(0)
  })

  it('leaves out a receipt that was cancelled', async () => {
    await buy(5, 'credit')
    const paid = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(200), method: 'cash', actorId: fx.adminId,
    })
    if (!paid.ok) throw new Error(paid.code)
    await cancelPayment(fx.db, { paymentId: paid.paymentId, actorId: fx.adminId })

    const account = await customerAccount(fx.db, customer)
    expect(account.entries.some((e) => e.kind === 'receipt')).toBe(false)
    expect(account.closingBalance).toBe(rupees(500))
  })
})

describe('goods that came back', () => {
  async function returnOne(billId: string, method: 'cash' | 'credit') {
    const bill = await fx.db.get<{ id: string }>(
      `SELECT id FROM bill_items WHERE bill_id = ? LIMIT 1`, [billId],
    )
    const done = await processReturn(fx.db, {
      billId,
      lines: [{ billItemId: bill!.id, qty: fromUnits(1) }],
      refundMethod: method,
      actorId: fx.adminId,
    })
    if (!done.ok) throw new Error(done.code)
    return done
  }

  it('shows the return, and says the money went back', async () => {
    const bill = await buy(3, 'cash')
    await returnOne(bill.billId, 'cash')

    const account = await customerAccount(fx.db, customer)
    const ret = account.entries.find((e) => e.kind === 'return')
    expect(ret?.description).toContain('refunded in cash')
    // The goods went back and so did the cash, so the account has not moved.
    expect(ret?.credit).toBe(0)
    expect(account.closingBalance).toBe(0)
    expect(account.totals.returned).toBe(rupees(100))
  })

  /* The trap this whole design is shaped around: a refund put on the account
     raises a credit note, which is a payment entry, so listing both would take
     the balance down twice for one lot of goods. */
  it('takes the account down once, not twice, when the refund is credited', async () => {
    const bill = await buy(3, 'credit')
    await returnOne(bill.billId, 'credit')

    const account = await customerAccount(fx.db, customer)
    const returns = account.entries.filter((e) => e.kind === 'return')
    expect(returns).toHaveLength(1)
    expect(returns[0]?.credit).toBe(rupees(100))
    expect(returns[0]?.description).toContain('on your account')

    expect(account.closingBalance).toBe(rupees(200))
    expect(account.closingBalance).toBe(await customerOutstanding(fx.db, customer))
  })

  it('does not list the credit note separately from the return that raised it', async () => {
    const bill = await buy(3, 'credit')
    await returnOne(bill.billId, 'credit')
    const account = await customerAccount(fx.db, customer)
    expect(account.entries.filter((e) => e.kind === 'receipt')).toHaveLength(0)
  })
})

describe('the running balance', () => {
  it('is right at every row, not only at the bottom', async () => {
    await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(1000), asOf: '2026-01-01',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    await buy(2, 'credit')
    await buy(1, 'cash')
    await recordPayment(fx.db, {
      customerId: customer, amount: rupees(500), method: 'cash', actorId: fx.adminId,
    })

    const account = await customerAccount(fx.db, customer)
    // 1000 opening, +200 on credit, +100 goods then -100 paid at the counter,
    // then -500 received.
    expect(account.entries.map((e) => e.balance)).toEqual([
      rupees(1000), rupees(1200), rupees(1300), rupees(1200), rupees(700),
    ])
    expect(account.closingBalance).toBe(await customerOutstanding(fx.db, customer))
  })

  /* A receipt listed above the bill it settles reads as an error even when the
     total is right, and a statement is read down the page. */
  it('puts a bill before the money paid against it on the same day', async () => {
    await buy(2, 'cash')
    const account = await customerAccount(fx.db, customer)
    expect(kinds(account)).toEqual(['bill', 'counter'])
  })
})

describe('a statement for one month', () => {
  async function threeMonths() {
    await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(1000), asOf: '2026-01-01',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    // Two bills dated by hand, because a statement window is the point here.
    const first = await buy(2, 'credit')
    const second = await buy(3, 'credit')
    await editingSubmitted(fx.db, 'bills', async () => {
      await fx.db.execute(`UPDATE bills SET posting_date = '2026-02-10' WHERE id = ?`, [first.billId])
      await fx.db.execute(`UPDATE bills SET posting_date = '2026-03-15' WHERE id = ?`, [second.billId])
    })
  }

  it('starts from what was owed before it, rather than in the middle of nowhere', async () => {
    await threeMonths()
    const account = await customerAccount(fx.db, customer, { from: '2026-03-01', to: '2026-03-31' })

    // January's opening balance and February's bill are not listed; they are the
    // figure the window starts from.
    expect(account.openingBalance).toBe(rupees(1200))
    expect(kinds(account)).toEqual(['bill'])
    expect(account.closingBalance).toBe(rupees(1500))
  })

  it('counts only what happened inside it', async () => {
    await threeMonths()
    const account = await customerAccount(fx.db, customer, { from: '2026-03-01', to: '2026-03-31' })
    expect(account.totals.bought).toBe(rupees(300))
  })

  it('is the whole account when no window is given', async () => {
    await threeMonths()
    const account = await customerAccount(fx.db, customer)
    expect(account.openingBalance).toBe(0)
    expect(account.entries).toHaveLength(3)
  })
})
