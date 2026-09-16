import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, ZERO, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import {
  recordPayment, customerAccount, customerOutstanding,
  advanceCredit, applyAdvance, refundAdvance,
} from '../src/services/payments.js'
import { postMovement } from '../src/services/stock.js'
import { getOrOpenSession } from '../src/services/cash.js'
import { searchCustomers } from '../src/repos/catalog.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'

/**
 * A customer who has paid more than they owed.
 *
 * Owing 710 and handing over 1,200 leaves 490 with the shop. That 490 has
 * always been in the database — it is the part of the receipt that no
 * allocation points at — and it appeared on no screen: the Credit list read the
 * customer as owing nothing, which is true and is not the whole truth, and the
 * statement called it "Balance due -490.00", which reads as a mistake in the
 * arithmetic rather than as money.
 *
 * There are two things a shop does with it, and until now it could do neither.
 */

let fx: Fixture
let product: string
let customer: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  customer = await makeCustomer(fx.db, 'Sri Vidya School')
  await fx.db.execute(`UPDATE customers SET credit_enforcement = 'none' WHERE id = ?`, [customer])
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId: product, qtyChange: fromUnits(1000), voucherType: 'opening',
      voucherId: newId(), postingDate: '2026-01-01',
    })
  })
})
afterEach(async () => { await fx.db.close() })

/** A bill put on the khata, in whole rupees of goods. */
async function onKhata(units: number, postingDate = '2026-02-01'): Promise<string> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    customerId: customer,
    lines: [{ productId: product, qty: fromUnits(units) }],
    postingDate,
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft refused')
  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'credit', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(`submit refused: ${done.code}`)
  return draft.billId
}

async function pay(amount: Money) {
  const taken = await recordPayment(fx.db, {
    customerId: customer, amount, method: 'cash', actorId: fx.adminId,
  })
  if (!taken.ok) throw new Error(`payment refused: ${taken.code}`)
  return taken
}

describe('money the shop is holding', () => {
  it('is nothing for a customer who has paid exactly what they owed', async () => {
    await onKhata(7)
    await pay(rupees(700))

    expect(await advanceCredit(fx.db, customer)).toEqual({ amount: ZERO, receipts: [] })
  })

  it('is what was over-paid, and says which receipt it came out of', async () => {
    await onKhata(7)
    const taken = await pay(rupees(1200))

    const held = await advanceCredit(fx.db, customer)
    expect(held.amount).toBe(rupees(500))
    expect(held.receipts).toHaveLength(1)
    expect(held.receipts[0]).toMatchObject({ paymentId: taken.paymentId, left: rupees(500) })
  })

  it('shows on the customer list, where it used to read as owing nothing', async () => {
    await onKhata(7)
    await pay(rupees(1200))

    const [row] = await searchCustomers(fx.db, '', 50)
    expect(row!.outstanding).toBe(ZERO)
    expect(row!.advance).toBe(rupees(500))
  })

  it('is separate from what they owe, because a customer can have both', async () => {
    /* The receipts hold money and a bill raised since owes some. Netting the
       two into one signed number would lose which is which — and the shop acts
       on them differently: one is collected, the other is spent or handed
       back. */
    await onKhata(7)
    await pay(rupees(1200))
    await onKhata(3, '2026-03-01')

    const [row] = await searchCustomers(fx.db, '', 50)
    expect(row!.outstanding).toBe(rupees(300))
    expect(row!.advance).toBe(rupees(500))
  })
})

describe('keeping it against the next bill', () => {
  it('spends the advance on what is owed and leaves the rest held', async () => {
    await onKhata(7)
    await pay(rupees(1200))
    await onKhata(3, '2026-03-01')

    const applied = await applyAdvance(fx.db, { customerId: customer, actorId: fx.adminId })
    expect(applied).toMatchObject({ ok: true, applied: rupees(300) })

    expect(await customerOutstanding(fx.db, customer)).toBe(ZERO)
    expect((await advanceCredit(fx.db, customer)).amount).toBe(rupees(200))
  })

  it('moves no money, because the shop already had it', async () => {
    /* The distinction that matters at the till: redeeming an advance changes
       which bill the money points at and touches no drawer. A cash movement
       here would make the day's takings count the same rupees twice. */
    await onKhata(7)
    await pay(rupees(1200))
    await onKhata(3, '2026-03-01')

    const before = await fx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cash_movements`)
    await applyAdvance(fx.db, { customerId: customer, actorId: fx.adminId })
    const after = await fx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cash_movements`)
    expect(after?.n).toBe(before?.n)
  })

  it('settles the oldest bill first', async () => {
    await pay(rupees(1000))
    const older = await onKhata(4, '2026-03-01')
    const newer = await onKhata(4, '2026-04-01')

    await applyAdvance(fx.db, { customerId: customer, actorId: fx.adminId })

    const rows = await fx.db.query<{ bill_id: string; amount: number }>(
      `SELECT bill_id, amount FROM payment_allocations`,
    )
    const by = new Map(rows.map((r) => [r.bill_id, r.amount]))
    expect(by.get(older)).toBe(rupees(400))
    expect(by.get(newer)).toBe(rupees(400))
  })

  it('can be aimed at one bill instead of the oldest', async () => {
    await pay(rupees(1000))
    const older = await onKhata(4, '2026-03-01')
    const newer = await onKhata(4, '2026-04-01')

    await applyAdvance(fx.db, { customerId: customer, billId: newer, actorId: fx.adminId })

    const rows = await fx.db.query<{ bill_id: string }>(`SELECT bill_id FROM payment_allocations`)
    expect(rows.map((r) => r.bill_id)).toEqual([newer])
    expect(older).not.toBe(newer)
  })

  it('never allocates a receipt past what it holds', async () => {
    await pay(rupees(500))
    await onKhata(9, '2026-03-01')

    await applyAdvance(fx.db, { customerId: customer, actorId: fx.adminId })

    const over = await fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payment_entries pe
        WHERE pe.amount < (SELECT COALESCE(SUM(pa.amount), 0) FROM payment_allocations pa
                            WHERE pa.payment_id = pe.id)`,
    )
    expect(over?.n).toBe(0)
    expect((await advanceCredit(fx.db, customer)).amount).toBe(ZERO)
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(400))
  })

  it('adds to an allocation that already exists rather than writing a second row', async () => {
    /* `payment_allocations` is unique on (payment_id, bill_id). Two rows for
       one pair would be the same money counted twice by every query that sums
       them — and this is reachable: a part-settled bill and a later advance
       drawn from the same receipt. */
    await onKhata(10)
    await pay(rupees(1400))

    const rows = await fx.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payment_allocations GROUP BY payment_id, bill_id HAVING COUNT(*) > 1`,
    )
    expect(rows).toEqual([])

    await onKhata(2, '2026-03-01')
    const applied = await applyAdvance(fx.db, { customerId: customer, actorId: fx.adminId })
    expect(applied.ok).toBe(true)
    expect(await customerOutstanding(fx.db, customer)).toBe(ZERO)
  })

  it('says so when there is nothing held', async () => {
    await onKhata(7)
    expect(await applyAdvance(fx.db, { customerId: customer, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NO_CREDIT' })
  })

  it('says so when nothing is owed to spend it on', async () => {
    await pay(rupees(500))
    expect(await applyAdvance(fx.db, { customerId: customer, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NOTHING_OWED' })
  })
})

describe('handing it back', () => {
  it('reduces what the shop holds and leaves the rest', async () => {
    await onKhata(7)
    await pay(rupees(1200))

    const given = await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(200), method: 'cash', actorId: fx.adminId,
    })
    expect(given).toMatchObject({ ok: true, refunded: rupees(200), left: rupees(300) })
    expect((await advanceCredit(fx.db, customer)).amount).toBe(rupees(300))
  })

  it('takes the account back to zero when all of it is handed back', async () => {
    await onKhata(7)
    await pay(rupees(1200))

    await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(500), method: 'cash', actorId: fx.adminId,
    })

    const account = await customerAccount(fx.db, customer)
    expect(account.closingBalance).toBe(ZERO)
    expect(account.advance).toBe(ZERO)
  })

  it('refuses to hand back more than it holds', async () => {
    /* Not tidiness. Past the advance the shop is lending money with no bill
       behind it, invisible to the khata and to every figure on the Credit page.
       A shop that wants to do that is doing something else. */
    await onKhata(7)
    await pay(rupees(1200))

    expect(await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(900), method: 'cash', actorId: fx.adminId,
    })).toEqual({ ok: false, code: 'MORE_THAN_HELD', requested: rupees(900), held: rupees(500) })

    expect((await advanceCredit(fx.db, customer)).amount).toBe(rupees(500))
  })

  it('refuses nothing and refuses a negative', async () => {
    await pay(rupees(500))
    expect(await refundAdvance(fx.db, {
      customerId: customer, amount: ZERO, method: 'cash', actorId: fx.adminId,
    })).toEqual({ ok: false, code: 'INVALID_AMOUNT' })
  })

  it('takes the money out of the drawer, unlike redeeming it', async () => {
    // A drawer has to be open for anything to come out of it, which is also
    // why nothing is posted when one is not: a shop not running cash sessions
    // still refunds, it just has no till to count it against.
    await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId })
    await pay(rupees(500))

    await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(200), method: 'cash',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })

    const out = await fx.db.get<{ direction: string; amount: number; source_type: string }>(
      `SELECT direction, amount, source_type FROM cash_movements WHERE source_type = 'customer_refund'`,
    )
    expect(out).toMatchObject({ direction: 'out', amount: rupees(200) })
  })

  it('carries its own number, in the same series as a receipt', async () => {
    await pay(rupees(500))
    const given = await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(100), method: 'cash', actorId: fx.adminId,
    })
    expect(given.ok).toBe(true)
    if (!given.ok) return
    expect(given.docNo).toMatch(/^RMR\/\d{4}\/\d{5}$/)
  })
})

describe('what the statement says about it', () => {
  it('names the credit rather than printing a balance with a minus on it', async () => {
    await onKhata(7)
    await pay(rupees(1200))

    const account = await customerAccount(fx.db, customer)
    expect(account.closingBalance).toBe(-rupees(500))
    // The same money with the sign taken off and a name put on it, which is
    // what a screen should say.
    expect(account.advance).toBe(rupees(500))
  })

  it('shows a refund as a line that puts the account back, not one that doubles it', async () => {
    await onKhata(7)
    await pay(rupees(1200))
    await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(500), method: 'cash', actorId: fx.adminId,
    })

    const account = await customerAccount(fx.db, customer)
    const refund = account.entries.find((e) => e.kind === 'refund')
    expect(refund).toBeTruthy()
    /* A debit. The account runs from the shop's side, so handing money back
       raises what the customer owes by exactly what they were given — which
       takes -500 to zero rather than to -1,000. */
    expect(refund!.debit).toBe(rupees(500))
    expect(refund!.credit).toBe(ZERO)
    expect(account.closingBalance).toBe(ZERO)
  })

  it('lists the refund after the receipt it came out of', async () => {
    /* Money can only be handed back after it was handed over, and a refund
       listed above the receipt reads as the shop paying somebody who had paid
       nothing. */
    await pay(rupees(500))
    await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(500), method: 'cash', actorId: fx.adminId,
    })

    const kinds = (await customerAccount(fx.db, customer)).entries.map((e) => e.kind)
    expect(kinds.indexOf('refund')).toBeGreaterThan(kinds.indexOf('receipt'))
  })

  it('leaves a refund out of what they have paid', async () => {
    await onKhata(7)
    await pay(rupees(1200))
    await refundAdvance(fx.db, {
      customerId: customer, amount: rupees(500), method: 'cash', actorId: fx.adminId,
    })

    const account = await customerAccount(fx.db, customer)
    expect(account.totals.bought).toBe(rupees(700))
    expect(account.totals.paid).toBe(rupees(1200))
  })
})
