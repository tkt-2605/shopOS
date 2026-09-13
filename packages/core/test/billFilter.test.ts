import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listBills, countBills } from '../src/repos/catalog.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { recordOpeningBalance, recordPayment } from '../src/services/payments.js'
import { processReturn } from '../src/services/returns.js'
import { postMovement } from '../src/services/stock.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Finding a bill again.
 *
 * The theme of this file is that "status" is four different questions, and each
 * filter has to answer its own without quietly answering one of the others.
 */

let fx: Fixture
let productId: string

beforeEach(async () => {
  fx = await freshDb()
  productId = await makeProduct(fx.db, { baseRate: 10000, taxRateBp: 0 })
  await stockUp(fx.db, productId, 500)
})

afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, id: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId: id, qtyChange: fromUnits(units), unitCost: 5000 as Money,
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    })
  })
}

/** A submitted bill on a given day, paid in cash unless it is taken on credit. */
async function billOn(date: string, opts: { customerId?: string; onCredit?: boolean } = {}) {
  const created = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    lines: [{ productId, qty: fromUnits(1) }],
    postingDate: date,
    actorId: fx.adminId,
  })
  if (!created.ok) throw new Error(`could not create a bill: ${created.code}`)

  const submitted = await submitBill(fx.db, {
    billId: created.billId,
    payments: [{ method: opts.onCredit ? 'credit' : 'cash', amount: created.grandTotal }],
    actorId: fx.adminId,
  })
  if (!submitted.ok) throw new Error(`could not submit a bill: ${submitted.code}`)

  return created.billId
}

async function returnEverything(billId: string): Promise<void> {
  const items = await fx.db.query<{ id: string }>(
    `SELECT id FROM bill_items WHERE bill_id = ?`, [billId],
  )
  const outcome = await processReturn(fx.db, {
    billId,
    lines: [{ billItemId: items[0]!.id, qty: fromUnits(1) }],
    refundMethod: 'cash',
    actorId: fx.adminId,
  })
  if (!outcome.ok) throw new Error('the return did not go through')
}

describe('filtering bills by date', () => {
  it('finds only the bills raised inside the chosen dates', async () => {
    await billOn('2026-03-10')
    const inside = await billOn('2026-04-15')
    await billOn('2026-05-20')

    const found = await listBills(fx.db, { from: '2026-04-01', to: '2026-04-30' })

    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(inside)
  })

  it('includes a bill raised on the last day of the window', async () => {
    await billOn('2026-04-30')
    expect(await countBills(fx.db, { from: '2026-04-01', to: '2026-04-30' })).toBe(1)
  })

  it('lists the newest first, so the bill just raised is at the top', async () => {
    await billOn('2026-04-01')
    await billOn('2026-04-20')
    await billOn('2026-04-10')

    const found = await listBills(fx.db, {})
    expect(found.map((b) => b.postingDate)).toEqual(['2026-04-20', '2026-04-10', '2026-04-01'])
  })
})

describe('filtering bills by status', () => {
  it('leaves a cancelled bill out of the live ones', async () => {
    const live = await billOn('2026-04-01')
    const dead = await billOn('2026-04-02')
    await cancelBill(fx.db, { billId: dead, reason: 'Rung up twice', actorId: fx.adminId })

    const found = await listBills(fx.db, { status: 'live' })

    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(live)
  })

  it('lists a cancelled bill only when cancelled ones are asked for', async () => {
    await billOn('2026-04-01')
    const dead = await billOn('2026-04-02')
    await cancelBill(fx.db, { billId: dead, reason: 'Rung up twice', actorId: fx.adminId })

    const found = await listBills(fx.db, { status: 'cancelled' })

    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(dead)
  })

  it('shows both under all, which is what the screen opens on', async () => {
    await billOn('2026-04-01')
    const dead = await billOn('2026-04-02')
    await cancelBill(fx.db, { billId: dead, reason: 'Rung up twice', actorId: fx.adminId })

    expect(await countBills(fx.db, { status: 'all' })).toBe(2)
  })

  it('finds a bill with goods back against it', async () => {
    await billOn('2026-04-01')
    const returnedBill = await billOn('2026-04-02')
    await returnEverything(returnedBill)

    const found = await listBills(fx.db, { status: 'returned' })

    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(returnedBill)
    expect(found[0]!.returned).toBe(true)
  })

  it('marks the returned bill on every list, not only the returned filter', async () => {
    const returnedBill = await billOn('2026-04-02')
    await returnEverything(returnedBill)

    const all = await listBills(fx.db, { status: 'all' })
    expect(all[0]!.returned).toBe(true)
  })

  it('finds what is still owed on the khata', async () => {
    const customerId = await makeCustomer(fx.db, 'Murugan')
    await billOn('2026-04-01')
    const owed = await billOn('2026-04-02', { customerId, onCredit: true })

    const found = await listBills(fx.db, { status: 'credit' })

    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(owed)
  })

  it('stops listing a credit bill once it has been paid off', async () => {
    const customerId = await makeCustomer(fx.db, 'Murugan')
    const owed = await billOn('2026-04-02', { customerId, onCredit: true })

    const bill = await fx.db.get<{ grand_total: number }>(
      `SELECT grand_total FROM bills WHERE id = ?`, [owed],
    )
    const paid = await recordPayment(fx.db, {
      customerId,
      amount: bill!.grand_total as Money,
      method: 'cash',
      allocations: [{ billId: owed, amount: bill!.grand_total as Money }],
      actorId: fx.adminId,
    })
    expect(paid.ok).toBe(true)

    // The column still says the bill went out on credit, because it did. But
    // sending a shopkeeper to ask for money already handed over is the bug this
    // filter exists to avoid.
    expect(await countBills(fx.db, { status: 'credit' })).toBe(0)
  })
})

describe('what never belongs on the bills screen', () => {
  it('keeps an opening balance out of the list whatever the filter says', async () => {
    const customerId = await makeCustomer(fx.db, 'Old khata')
    await recordOpeningBalance(fx.db, {
      customerId, amount: rupees(4000), asOf: '2026-04-01',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })
    await billOn('2026-04-01')

    for (const status of ['all', 'live', 'cancelled', 'returned', 'credit'] as const) {
      const found = await listBills(fx.db, { status })
      expect(found.every((b) => b.docNo.startsWith('INV/'))).toBe(true)
    }
    expect(await countBills(fx.db, { status: 'all' })).toBe(1)
  })

  it('keeps a parked draft out of the list', async () => {
    await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })

    expect(await countBills(fx.db, {})).toBe(0)
  })
})

describe('searching and paging', () => {
  it('finds a bill by part of its number', async () => {
    const id = await billOn('2026-04-01')
    const bill = await fx.db.get<{ doc_no: string }>(`SELECT doc_no FROM bills WHERE id = ?`, [id])
    const tail = bill!.doc_no.slice(-4)

    const found = await listBills(fx.db, { search: tail })
    expect(found.map((b) => b.id)).toContain(id)
  })

  it('finds a bill by the customer it went to', async () => {
    const customerId = await makeCustomer(fx.db, 'Lakshmi Traders')
    const theirs = await billOn('2026-04-01', { customerId })
    await billOn('2026-04-02')

    const found = await listBills(fx.db, { search: 'lakshmi' })

    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(theirs)
  })

  it('never shows the same bill on two pages', async () => {
    for (let i = 1; i <= 5; i++) await billOn(`2026-04-0${i}`)

    const first = await listBills(fx.db, { limit: 2, offset: 0 })
    const second = await listBills(fx.db, { limit: 2, offset: 2 })

    expect(first).toHaveLength(2)
    expect(await countBills(fx.db, {})).toBe(5)
    expect(first.some((a) => second.some((b) => a.id === b.id))).toBe(false)
  })

  it('counts the same bills the list shows, filter for filter', async () => {
    const dead = await billOn('2026-04-01')
    await billOn('2026-04-02')
    await cancelBill(fx.db, { billId: dead, reason: 'Wrong customer', actorId: fx.adminId })

    for (const status of ['all', 'live', 'cancelled', 'returned', 'credit'] as const) {
      const rows = await listBills(fx.db, { status, limit: 500 })
      expect(await countBills(fx.db, { status })).toBe(rows.length)
    }
  })
})
