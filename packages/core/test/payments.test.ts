import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, ZERO, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { recordPayment, cancelPayment, customerOutstanding, customerStatement } from '../src/services/payments.js'
import { postMovement } from '../src/services/stock.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture
let product: string
let customer: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  customer = await makeCustomer(fx.db)
  await fx.db.execute(`UPDATE customers SET credit_enforcement = 'none' WHERE id = ?`, [customer])
  await stockUp(fx.db, product, 1000)
})
afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId, qtyChange: fromUnits(units), voucherType: 'opening',
      voucherId: newId(), postingDate: '2026-01-01',
    })
  })
}

async function creditSale(units: number, postingDate: string): Promise<Money> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    customerId: customer,
    lines: [{ productId: product, qty: fromUnits(units) }],
    postingDate,
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const r = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'credit', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!r.ok) throw new Error(`submit failed: ${r.code}`)
  return draft.grandTotal
}

describe('outstanding', () => {
  it('rises with each credit sale', async () => {
    expect(await customerOutstanding(fx.db, customer)).toBe(ZERO)
    await creditSale(2, '2026-01-01')
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(200))
    await creditSale(3, '2026-01-02')
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(500))
  })

  it('ignores cash bills', async () => {
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, customerId: customer,
      lines: [{ productId: product, qty: fromUnits(5) }], actorId: fx.adminId,
    })
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    expect(await customerOutstanding(fx.db, customer)).toBe(ZERO)
  })
})

describe('recording a receipt', () => {
  it('clears oldest bills first', async () => {
    await creditSale(2, '2026-01-01')
    await creditSale(3, '2026-01-02')

    const r = await recordPayment(fx.db, { customerId: customer, amount: rupees(350), method: 'cash', actorId: fx.adminId })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.docNo).toMatch(/^RMR\//)
    expect(r.allocations).toHaveLength(2)
    expect(r.allocated).toBe(rupees(350))
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(150))

    const statement = await customerStatement(fx.db, customer)
    expect(statement).toHaveLength(1)
    expect(statement[0]?.outstanding).toBe(rupees(150))
  })

  it('leaves an overpayment unallocated rather than inventing a bill', async () => {
    await creditSale(2, '2026-01-01')
    const r = await recordPayment(fx.db, { customerId: customer, amount: rupees(500), method: 'cash', actorId: fx.adminId })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.allocated).toBe(rupees(200))
      expect(r.unallocated).toBe(rupees(300))
    }
    expect(await customerOutstanding(fx.db, customer)).toBe(ZERO)
  })

  it('settles a bill exactly', async () => {
    const total = await creditSale(4, '2026-01-01')
    await recordPayment(fx.db, { customerId: customer, amount: total, method: 'upi', reference: 'UPI123', actorId: fx.adminId })
    expect(await customerOutstanding(fx.db, customer)).toBe(ZERO)
    expect(await customerStatement(fx.db, customer)).toHaveLength(0)
  })

  it('rejects a zero or negative amount', async () => {
    const r = await recordPayment(fx.db, { customerId: customer, amount: ZERO, method: 'cash', actorId: fx.adminId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_AMOUNT')
  })
})

describe('manual allocation', () => {
  it('honours the bills the user picked', async () => {
    await creditSale(2, '2026-01-01')
    await creditSale(3, '2026-01-02')
    const statement = await customerStatement(fx.db, customer)
    const newer = statement[1]!

    const r = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(300), method: 'cash',
      allocations: [{ billId: newer.billId, amount: rupees(300) }],
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(true)

    const after = await customerStatement(fx.db, customer)
    expect(after).toHaveLength(1)
    expect(after[0]?.docNo).toBe(statement[0]!.docNo)
  })

  it('refuses to allocate more than a bill is due', async () => {
    await creditSale(2, '2026-01-01')
    const statement = await customerStatement(fx.db, customer)

    const r = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(500), method: 'cash',
      allocations: [{ billId: statement[0]!.billId, amount: rupees(500) }],
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'OVER_ALLOCATED') expect(r.due).toBe(rupees(200))
  })

  it('refuses to allocate more than the payment', async () => {
    await creditSale(5, '2026-01-01')
    const statement = await customerStatement(fx.db, customer)

    const r = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(100), method: 'cash',
      allocations: [{ billId: statement[0]!.billId, amount: rupees(400) }],
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ALLOCATION_EXCEEDS_PAYMENT')
  })
})

describe('cancelling a receipt', () => {
  it('puts the outstanding back without deleting the allocations', async () => {
    await creditSale(5, '2026-01-01')
    const r = await recordPayment(fx.db, { customerId: customer, amount: rupees(300), method: 'cash', actorId: fx.adminId })
    if (!r.ok) return
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(200))

    await cancelPayment(fx.db, { paymentId: r.paymentId, reason: 'cheque bounced', actorId: fx.adminId })
    expect(await customerOutstanding(fx.db, customer)).toBe(rupees(500))

    const allocations = await fx.db.query(`SELECT id FROM payment_allocations WHERE payment_id = ?`, [r.paymentId])
    expect(allocations).toHaveLength(1)
  })

  it('cannot be cancelled twice', async () => {
    await creditSale(2, '2026-01-01')
    const r = await recordPayment(fx.db, { customerId: customer, amount: rupees(100), method: 'cash', actorId: fx.adminId })
    if (!r.ok) return
    await cancelPayment(fx.db, { paymentId: r.paymentId, actorId: fx.adminId })
    await expect(cancelPayment(fx.db, { paymentId: r.paymentId, actorId: fx.adminId })).rejects.toThrow(/cancelled/)
  })
})

describe('credit limit uses derived outstanding', () => {
  it('frees headroom again once the customer pays', async () => {
    await fx.db.execute(`UPDATE customers SET credit_limit = ?, credit_enforcement = 'hard' WHERE id = ?`, [rupees(300), customer])

    await creditSale(3, '2026-01-01')

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, customerId: customer,
      lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!draft.ok) return
    const blocked = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'credit', amount: draft.grandTotal }], actorId: fx.adminId,
    })
    expect(blocked.ok).toBe(false)

    await recordPayment(fx.db, { customerId: customer, amount: rupees(300), method: 'cash', actorId: fx.adminId })

    const allowed = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'credit', amount: draft.grandTotal }], actorId: fx.adminId,
    })
    expect(allowed.ok).toBe(true)
  })
})
