import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { findDiscrepancies, discrepanciesWithSeen, markDiscrepanciesSeen } from '../src/services/discrepancies.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { createReturn, submitReturn } from '../src/services/returns.js'
import { createDocument, submitDocument } from '../src/services/documents.js'
import { documentToCart } from '../src/services/convert.js'
import { createRegister, claimRegister } from '../src/services/registers.js'
import { postMovement } from '../src/services/stock.js'
import { setStockPolicy } from '../src/services/features.js'
import { setDeviceId } from '../src/device.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { TILL_A, TILL_B, as, pull, type Till } from './twoTills.js'
import { aMonthOfTrade } from './monthOfTrade.js'

/**
 * Everything that does not add up, told to a person.
 *
 * From a shopkeeper's question: a customer returns the same shirt at two
 * counters while they cannot reach each other, both refund it, and then they
 * sync -- what happens? Both refunds stood, the stock showed the shirt back
 * twice, and nothing said so anywhere. Neither counter could have refused; the
 * shop has to be told afterwards, and about every other thing of the kind.
 */

let fx: Fixture
let a: Till
let b: Till
let shirt: string

beforeEach(async () => {
  fx = await freshDb()
  a = { id: TILL_A, db: fx.db }
  b = { id: TILL_B, db: await emptyDb() }
  shirt = await as(TILL_A, async () => {
    const p = await makeProduct(a.db, { name: 'Shirt', baseRate: rupees(1000), taxRateBp: 0 })
    await a.db.transaction((tx) => postMovement(tx, {
      productId: p, qtyChange: fromUnits(10), unitCost: rupees(600), voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    }))
    return p
  })
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

const kinds = async (t: Till) => (await findDiscrepancies(t.db)).map((d) => d.kind)

/** A second counter on B, so the two tills bill in their own series. */
async function twoCounters() {
  await as(TILL_A, async () => {
    const second = await createRegister(a.db, { name: 'Front', prefix: 'FC', actorId: fx.adminId })
    if (!second.ok) throw new Error(second.code)
    await claimRegister(a.db, { registerId: fx.seed.registerId })
  })
  await pull(b, a)
  await as(TILL_B, async () => {
    const fc = await b.db.get<{ id: string }>(`SELECT id FROM registers WHERE prefix = 'FC'`)
    await claimRegister(b.db, { registerId: fc!.id })
  })
  await pull(a, b)
}

async function sellShirt(units = 1): Promise<{ billId: string; itemId: string }> {
  return as(TILL_A, async () => {
    const d = await createBill(a.db, { registerId: fx.seed.registerId, lines: [{ productId: shirt, qty: fromUnits(units) }], actorId: fx.adminId })
    if (!d.ok) throw new Error(d.code)
    const paid = await submitBill(a.db, { billId: d.billId, payments: [{ method: 'cash', amount: d.grandTotal }], actorId: fx.adminId })
    if (!paid.ok) throw new Error(paid.code)
    const item = await a.db.get<{ id: string }>('SELECT id FROM bill_items WHERE bill_id = ?', [d.billId])
    return { billId: d.billId, itemId: item!.id }
  })
}

async function refundAt(t: Till, sale: { billId: string; itemId: string }): Promise<string> {
  return as(t.id, async () => {
    const ret = await createReturn(t.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) throw new Error(ret.code)
    const done = await submitReturn(t.db, { returnId: ret.returnId, actorId: fx.adminId })
    if (!done.ok) throw new Error(done.code)
    return done.docNo
  })
}

describe('a shop with nothing wrong', () => {
  it('has nothing to report after a month of trade', async () => {
    const clean = await freshDb()
    try {
      await aMonthOfTrade(clean)
      expect(await findDiscrepancies(clean.db)).toEqual([])
    } finally {
      await clean.db.close()
    }
  })
})

describe('one item refunded at two counters while apart', () => {
  it('is reported on both tills once they sync, with both credit notes and the money', async () => {
    await twoCounters()
    const sale = await sellShirt()
    await pull(b, a)
    const onA = await refundAt(a, sale)
    const onB = await refundAt(b, sale)
    await pull(b, a)
    await pull(a, b)

    for (const till of [a, b]) {
      const found = (await findDiscrepancies(till.db)).filter((d) => d.kind === 'refunded_twice')
      expect(found).toHaveLength(1)
      expect(found[0]!.amount).toBe(rupees(1000))
      expect(found[0]!.refs).toEqual(expect.arrayContaining([onA, onB]))
      expect(found[0]!.detail).toContain('₹2,000.00')
    }
  })

  it('is not reported for two honest partial returns of one line', async () => {
    await twoCounters()
    const sale = await sellShirt(2)
    await pull(b, a)
    await refundAt(a, sale)
    await refundAt(b, sale)
    await pull(b, a)
    await pull(a, b)
    expect(await kinds(a)).not.toContain('refunded_twice')
  })
})

describe('an order billed at two counters while apart', () => {
  it('is reported once they sync', async () => {
    await twoCounters()
    const customer = await as(TILL_A, () => makeCustomer(a.db, 'Anand'))
    const orderId = await as(TILL_A, async () => {
      const made = await createDocument(a.db, {
        kind: 'sales_order', registerId: fx.seed.registerId, customerId: customer,
        lines: [{ productId: shirt, qty: fromUnits(2) }], actorId: fx.adminId,
      })
      if (!made.ok) throw new Error(made.code)
      await submitDocument(a.db, { documentId: made.documentId, actorId: fx.adminId })
      return made.documentId
    })
    await pull(b, a)

    for (const till of [a, b]) {
      await as(till.id, async () => {
        const loaded = await documentToCart(till.db, { documentId: orderId })
        if (!loaded.ok) throw new Error(loaded.code)
        const register = await till.db.get<{ id: string }>(
          `SELECT id FROM registers WHERE claimed_by = ?`, [till.id])
        const d = await createBill(till.db, {
          registerId: register!.id, customerId: loaded.customerId, convertedFrom: loaded.documentId,
          lines: loaded.lines.map((l) => ({
            productId: l.productId, saleUnit: l.saleUnit, qty: l.qty,
            resolved: { rate: l.rate, source: 'order_rate' as const, sourceId: loaded.documentId },
          })),
          actorId: fx.adminId,
        })
        if (!d.ok) throw new Error(d.code)
        const paid = await submitBill(till.db, { billId: d.billId, payments: [{ method: 'cash', amount: d.grandTotal }], actorId: fx.adminId })
        if (!paid.ok) throw new Error(paid.code)
      })
    }
    await pull(b, a)
    await pull(a, b)
    expect(await kinds(a)).toContain('order_billed_twice')
    expect(await kinds(b)).toContain('order_billed_twice')
  })
})

describe('on one till', () => {
  it('reports stock sold below zero', async () => {
    await setStockPolicy(fx.db, { actorId: fx.adminId }, 'allow')
    await sellShirt(12)
    const found = (await findDiscrepancies(fx.db)).find((d) => d.kind === 'sold_below_zero')
    expect(found?.detail).toContain('-2')
  })

  it('reports a customer past their credit limit', async () => {
    const customer = await makeCustomer(fx.db, 'Bhavani')
    const d = await createBill(fx.db, {
      registerId: fx.seed.registerId, customerId: customer, lines: [{ productId: shirt, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!d.ok) throw new Error(d.code)
    const paid = await submitBill(fx.db, { billId: d.billId, payments: [{ method: 'credit', amount: d.grandTotal }], actorId: fx.adminId })
    if (!paid.ok) throw new Error(paid.code)
    // The limit as the other counter saw it, lower than what is now owed.
    await fx.db.execute(`UPDATE customers SET credit_limit = ?, credit_enforcement = 'hard' WHERE id = ?`, [rupees(600), customer])

    const found = (await findDiscrepancies(fx.db)).find((d) => d.kind === 'over_credit_limit')
    expect(found?.amount).toBe(rupees(400))
  })

  it('reports a submitted document missing from the books', async () => {
    const sale = await sellShirt()
    await fx.db.execute(`DROP TRIGGER gl_entries_is_append_only_del`)
    await fx.db.execute(`DELETE FROM gl_entries WHERE voucher_id = ?`, [sale.billId])
    expect(await kinds(a)).toContain('books_missing')
  })
})

describe('marking one seen', () => {
  it('keeps it quiet until the facts change', async () => {
    await twoCounters()
    const sale = await sellShirt(1)
    await pull(b, a)
    await refundAt(a, sale)
    await refundAt(b, sale)
    await pull(a, b)

    const [first] = (await discrepanciesWithSeen(a.db)).filter((d) => d.kind === 'refunded_twice')
    expect(first!.seen).toBe(false)
    await markDiscrepanciesSeen(a.db, { keys: [first!.key], actorId: fx.adminId })
    const [again] = (await discrepanciesWithSeen(a.db)).filter((d) => d.kind === 'refunded_twice')
    expect(again!.seen).toBe(true)

    // Seen here is not seen on the other counter.
    const [onB] = (await discrepanciesWithSeen(b.db)).filter((d) => d.kind === 'refunded_twice')
    expect(onB!.seen).toBe(false)

    // And something new is news.
    await as(TILL_A, () => setStockPolicy(a.db, { actorId: fx.adminId }, 'allow'))
    await sellShirt(12)
    const below = (await discrepanciesWithSeen(a.db)).find((d) => d.kind === 'sold_below_zero')
    expect(below?.seen).toBe(false)
  })
})
