import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { recordOpeningBalance, customerAccount, advanceCredit, customerOutstanding } from '../src/services/payments.js'
import { getOrOpenSession, sessionSummary } from '../src/services/cash.js'
import { freshDb, makeCustomer, type Fixture } from './helpers.js'

/**
 * A balance carried over can point either way.
 *
 * Every shop moving onto this from a paper book has both: people who owe it
 * money, and people whose money it is holding. Until now only the first could
 * be entered, so the second was either typed in as a fake bill — which makes
 * the shop appear to have sold something it did not — or left out, which means
 * the first time that customer comes in they are charged for goods they have
 * already paid for.
 *
 * The two are not one number with a sign. `advanceCredit` argues that at
 * length: "owes nothing" ends a conversation, "we are holding 490 of yours"
 * starts one.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function opening(customerId: string, amount: Money, asOf?: string) {
  return recordOpeningBalance(fx.db, {
    customerId,
    amount,
    ...(asOf === undefined ? {} : { asOf }),
    registerId: fx.seed.registerId,
    actorId: fx.adminId,
  })
}

describe('a customer who owed the shop', () => {
  it('is recorded as a bill, as it always was', async () => {
    const id = await makeCustomer(fx.db, 'Owes us')

    const result = await opening(id, rupees(2000))
    expect(result).toMatchObject({ ok: true, direction: 'owed' })

    expect(await customerOutstanding(fx.db, id)).toBe(rupees(2000))
  })
})

describe('a customer whose money the shop was holding', () => {
  it('is recorded as an advance, not as a negative bill', async () => {
    const id = await makeCustomer(fx.db, 'Paid ahead')

    const result = await opening(id, -rupees(500) as Money)
    expect(result).toMatchObject({ ok: true, direction: 'held' })

    /* The whole point. They owe nothing, and the shop owes them 500 — two
       answers to two questions, not one signed number. */
    expect(await customerOutstanding(fx.db, id)).toBe(0)
    expect((await advanceCredit(fx.db, id)).amount).toBe(rupees(500))
  })

  it('does not put the money in today\'s drawer', async () => {
    /* The money arrived before ShopOS existed. Counting it tonight would make
       the drawer short by exactly this amount, and the cashier would be told
       they had lost it. */
    const id = await makeCustomer(fx.db, 'Paid ahead')
    const session = await getOrOpenSession(fx.db, {
      registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000),
    })

    await opening(id, -rupees(500) as Money)

    const summary = await sessionSummary(fx.db, session.sessionId)
    expect(summary.expectedCash).toBe(rupees(1000))
  })

  it('is dated the day the old book closed, not today', async () => {
    const id = await makeCustomer(fx.db, 'Paid ahead')
    await opening(id, -rupees(500) as Money, '2026-03-31')

    const row = await fx.db.get<{ posting_date: string; method: string }>(
      'SELECT posting_date, method FROM payment_entries WHERE customer_id = ?', [id],
    )
    expect(row?.posting_date).toBe('2026-03-31')
    // `adjustment` is what keeps it out of the cash session.
    expect(row?.method).toBe('adjustment')
  })

  it('shows on the statement where it happened', async () => {
    const id = await makeCustomer(fx.db, 'Paid ahead')
    await opening(id, -rupees(500) as Money, '2026-03-31')

    const account = await customerAccount(fx.db, id, {})
    const line = account.entries.find((e) => e.postingDate === '2026-03-31')
    expect(line).toBeDefined()
    expect(line?.credit).toBe(rupees(500))

    /* The closing figure is signed so the page adds up; `advance` is the same
       money with the sign taken off and a name on it, which is what a screen
       shows. Both, because the statement has to reconcile either way. */
    expect(account.closingBalance).toBe(-rupees(500))
    expect(account.advance).toBe(rupees(500))
  })

  it('refuses a second one, the way the owed direction does', async () => {
    const id = await makeCustomer(fx.db, 'Paid ahead')
    const first = await opening(id, -rupees(500) as Money)
    expect(first.ok).toBe(true)

    const again = await opening(id, -rupees(300) as Money)
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_SET' })
  })

  it('leaves an ordinary receipt alone when deciding that', async () => {
    /* The guard reads the document series, so a customer who has simply paid
       a lot over the counter must not be refused an opening advance. */
    const id = await makeCustomer(fx.db, 'Pays often')
    const { recordPayment } = await import('../src/services/payments.js')
    await recordPayment(fx.db, {
      customerId: id, amount: rupees(900), method: 'cash',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })

    expect(await opening(id, -rupees(500) as Money)).toMatchObject({ ok: true })
  })
})

describe('zero', () => {
  it('is refused in both directions', async () => {
    const id = await makeCustomer(fx.db, 'Square')
    expect(await opening(id, rupees(0))).toEqual({ ok: false, code: 'INVALID_AMOUNT' })
  })
})
