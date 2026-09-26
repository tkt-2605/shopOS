import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { createReturn, submitReturn, processReturn } from '../src/services/returns.js'
import { postMovement } from '../src/services/stock.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

/*
 * A submit reads the document, checks it, and only then opens a transaction.
 * The till queues writes rather than refusing them, so a second click on a
 * payment button used to read the same draft, pass the same check, and wait its
 * turn to post everything again.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

/** The till's write queue, as `serializingDriver` has it: one transaction at a time, in order. */
function queued(db: SqlDriver): SqlDriver {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    query: (sql, params) => db.query(sql, params),
    get: (sql, params) => db.get(sql, params),
    queryValues: (sql, params) => db.queryValues(sql, params),
    execute: (sql, params) => db.execute(sql, params),
    close: () => db.close(),
    transaction(fn, opts) {
      const run = tail.then(() => db.transaction(fn, opts))
      tail = run.catch(() => undefined)
      return run
    },
  }
}

async function stocked(units: number): Promise<string> {
  const productId = await makeProduct(fx.db, { baseRate: rupees(100) })
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId, qtyChange: fromUnits(units), unitCost: 5000 as Money,
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    })
  })
  return productId
}

async function draft(productId: string, units: number): Promise<string> {
  const made = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(made.code)
  return made.billId
}

describe('a bill submitted twice at once', () => {
  it('posts once', async () => {
    const p = await stocked(10)
    const billId = await draft(p, 2)
    const db = queued(fx.db)
    const pay = () => submitBill(db, {
      billId, payments: [{ method: 'cash', amount: rupees(200) }], actorId: fx.adminId,
    })

    const outcomes = await Promise.allSettled([pay(), pay()])

    expect(outcomes.filter((o) => o.status === 'fulfilled' && o.value.ok)).toHaveLength(1)
    const payments = await fx.db.query(`SELECT id FROM bill_payments WHERE bill_id = ?`, [billId])
    const moves = await fx.db.query(`SELECT id FROM stock_ledger WHERE voucher_id = ?`, [billId])
    expect(payments).toHaveLength(1)
    expect(moves).toHaveLength(1)
  })

  it('refuses a tender of nothing or less, and a tender that claims to be points', async () => {
    const p = await stocked(10)
    const billId = await draft(p, 1)

    const negative = await submitBill(fx.db, {
      billId,
      payments: [{ method: 'cash', amount: rupees(150) }, { method: 'upi', amount: rupees(-50) }],
      actorId: fx.adminId,
    })
    expect(negative).toMatchObject({ ok: false, code: 'INVALID_PAYMENT' })

    const points = await submitBill(fx.db, {
      billId, payments: [{ method: 'loyalty', amount: rupees(100) }], actorId: fx.adminId,
    })
    expect(points).toMatchObject({ ok: false, code: 'INVALID_PAYMENT' })
  })
})

describe('returning more than was sold', () => {
  async function sold(units: number): Promise<{ billId: string; itemId: string }> {
    const p = await stocked(10)
    const billId = await draft(p, units)
    const paid = await submitBill(fx.db, {
      billId, payments: [{ method: 'cash', amount: rupees(100 * units) }], actorId: fx.adminId,
    })
    if (!paid.ok) throw new Error(paid.code)
    const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [billId])
    return { billId, itemId: item!.id }
  }

  it('counts the same line named twice as one line', async () => {
    const { billId, itemId } = await sold(5)
    const r = await processReturn(fx.db, {
      billId,
      lines: [{ billItemId: itemId, qty: fromUnits(3) }, { billItemId: itemId, qty: fromUnits(3) }],
      refundMethod: 'cash',
      actorId: fx.adminId,
    })
    expect(r).toMatchObject({ ok: false, code: 'EXCEEDS_RETURNABLE' })
  })

  it('checks again at submit, against returns submitted since the draft', async () => {
    const { billId, itemId } = await sold(5)
    const input = {
      billId, lines: [{ billItemId: itemId, qty: fromUnits(3) }], refundMethod: 'cash' as const, actorId: fx.adminId,
    }
    const first = await createReturn(fx.db, input)
    const second = await createReturn(fx.db, input)
    if (!first.ok || !second.ok) throw new Error('drafts should both be made')

    expect((await submitReturn(fx.db, { returnId: first.returnId, actorId: fx.adminId })).ok).toBe(true)
    expect(await submitReturn(fx.db, { returnId: second.returnId, actorId: fx.adminId }))
      .toMatchObject({ ok: false, code: 'EXCEEDS_RETURNABLE' })

    const line = await fx.db.get<{ returned_qty: number }>(`SELECT returned_qty FROM bill_items WHERE id = ?`, [itemId])
    expect(line?.returned_qty).toBe(fromUnits(3))
  })
})
