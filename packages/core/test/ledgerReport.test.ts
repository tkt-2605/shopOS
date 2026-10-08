import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { recordPayment } from '../src/services/payments.js'
import { postMovement } from '../src/services/stock.js'
import { generalLedger } from '../src/repos/ledger.js'
import { businessDate, addDays } from '../src/dates.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Every entry in the books on one page: a credit bill and the payment against
 * it, found by account and by customer, with the running balance a khata is
 * read by.
 */

let fx: Fixture
let customer: string
let other: string
const today = businessDate()

beforeEach(async () => {
  fx = await freshDb()
  const product = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(50), taxRateBp: 0 })
  await postMovement(fx.db, {
    productId: product, qtyChange: fromUnits(100), valueChange: rupees(3000),
    voucherType: 'opening', voucherId: 'o1', postingDate: today,
  } as never)
  customer = await makeCustomer(fx.db, 'Sri Vidya School')
  other = await makeCustomer(fx.db, 'Kumar Stores')

  for (const [who, units] of [[customer, 4], [other, 2]] as const) {
    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId, customerId: who,
      lines: [{ productId: product, qty: fromUnits(units) }], actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)
    const done = await submitBill(fx.db, {
      billId: bill.billId, payments: [{ method: 'credit', amount: bill.grandTotal }], actorId: fx.adminId,
    })
    if (!done.ok) throw new Error(done.code)
  }
  const paid = await recordPayment(fx.db, { customerId: customer, amount: rupees(150), method: 'cash', actorId: fx.adminId })
  if (!paid.ok) throw new Error(paid.code)
})

afterEach(async () => {
  await fx.db.close()
})

describe('the general ledger', () => {
  it('lists every entry in the range, and they balance', async () => {
    const all = await generalLedger(fx.db, { from: today, to: today })
    expect(all.rows.length).toBeGreaterThan(0)
    expect(all.debit).toBe(all.credit)
    expect(all.truncated).toBe(false)
  })

  it('narrowed to the customers’ account, holds every credit sale and payment, named', async () => {
    const khata = await generalLedger(fx.db, { from: today, to: today, account: 'debtors' })
    expect(khata.rows.map((r) => [r.voucherLabel, r.partyName, r.debit, r.credit])).toEqual([
      ['Bill', 'Sri Vidya School', rupees(200), 0],
      ['Bill', 'Kumar Stores', rupees(100), 0],
      ['Payment', 'Sri Vidya School', 0, rupees(150)],
    ])
    expect(khata.rows.every((r) => r.docNo)).toBe(true)
    expect(khata.closing).toBe(rupees(150))
  })

  it('narrowed to one customer, is their khata with a running balance', async () => {
    const one = await generalLedger(fx.db, {
      from: today, to: today, account: 'debtors', party: { type: 'customer', id: customer },
    })
    expect(one.rows.map((r) => r.balance)).toEqual([rupees(200), rupees(50)])
  })

  it('brings forward what came before the range', async () => {
    const tomorrow = addDays(today, 1)
    const later = await generalLedger(fx.db, { from: tomorrow, to: tomorrow, account: 'debtors' })
    expect(later.rows).toEqual([])
    expect(later.opening).toBe(rupees(150))
    expect(later.closing).toBe(rupees(150))
  })

  it('says when it stopped short, and still counts everything in the totals', async () => {
    const short = await generalLedger(fx.db, { from: today, to: today, account: 'debtors', limit: 1 })
    expect(short.rows).toHaveLength(1)
    expect(short.truncated).toBe(true)
    expect(short.closing).toBe(rupees(150))
  })
})
