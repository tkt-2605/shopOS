import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeBooks, booksClosedThrough } from '../src/services/books.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { recordPayment, cancelPayment } from '../src/services/payments.js'
import { processReturn, cancelReturn } from '../src/services/returns.js'
import { createStockEntry, submitStockEntry, cancelStockEntry } from '../src/services/stockEntry.js'
import { recordOpeningBalance } from '../src/services/payments/khata.js'
import { createSupplier, setSupplierOpening } from '../src/services/suppliers.js'
import { setSetting } from '../src/services/settings.js'
import { openCount, setCounted, submitCount, cancelCount } from '../src/services/stockCount.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Books closed through a date: nothing on or before it moves.
 *
 * From the review of 4 October. A bill in a month whose return had been filed
 * could be cancelled at any time afterwards, and the GST export -- which leaves
 * cancelled bills out as "never filed" -- then disagreed with the return that
 * had gone in.
 */

let fx: Fixture
let product: string
beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  const stock = await createStockEntry(fx.db, {
    entryType: 'opening', postingDate: '2026-04-01',
    lines: [{ productId: product, qty: fromUnits(100), unitCost: rupees(50) }],
    actorId: fx.adminId, now: new Date('2026-04-01T09:00:00'),
  })
  if (!stock.ok) throw new Error(stock.code)
  await submitStockEntry(fx.db, { entryId: stock.entryId, actorId: fx.adminId })
})
afterEach(async () => { await fx.db.close() })

const JUNE = new Date('2026-06-15T12:00:00')

async function sale(on: string, customerId?: string, onCredit = false): Promise<string> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }],
    ...(customerId ? { customerId } : {}),
    actorId: fx.adminId, now: new Date(`${on}T10:00:00`),
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: onCredit ? 'credit' : 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId, now: new Date(`${on}T10:00:00`),
  })
  if (!done.ok) throw new Error(done.code)
  return draft.billId
}

async function closeMay(): Promise<void> {
  const r = await closeBooks(fx.db, { through: '2026-05-31', actorId: fx.adminId, now: JUNE })
  expect(r).toEqual({ ok: true, closedThrough: '2026-05-31' })
}

const REFUSED = { ok: false, code: 'PERIOD_CLOSED', closedThrough: '2026-05-31' }

describe('closing the books', () => {
  it('is nothing until somebody closes them', async () => {
    expect(await booksClosedThrough(fx.db)).toBeNull()
  })

  it('refuses today and anything after, which is still being traded', async () => {
    expect(await closeBooks(fx.db, { through: '2026-06-15', actorId: fx.adminId, now: JUNE }))
      .toEqual({ ok: false, code: 'NOT_BEFORE_TODAY', today: '2026-06-15' })
    expect(await closeBooks(fx.db, { through: '15/06/2026', actorId: fx.adminId, now: JUNE }))
      .toEqual({ ok: false, code: 'INVALID_DATE' })
    expect(await booksClosedThrough(fx.db)).toBeNull()
  })

  it('can be reopened, and says so in the audit log', async () => {
    await closeMay()
    expect(await closeBooks(fx.db, { through: null, actorId: fx.adminId, now: JUNE }))
      .toEqual({ ok: true, closedThrough: null })
    expect(await booksClosedThrough(fx.db)).toBeNull()
    const audit = await fx.db.query<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity_id = 'books_closed_through' ORDER BY at`)
    expect(audit).toHaveLength(2)
  })
})

describe('what a closed period refuses', () => {
  it('cancelling a bill in it', async () => {
    const may = await sale('2026-05-10')
    const june = await sale('2026-06-02')
    await closeMay()
    expect(await cancelBill(fx.db, { billId: may, actorId: fx.adminId })).toEqual(REFUSED)
    expect((await cancelBill(fx.db, { billId: june, actorId: fx.adminId })).ok).toBe(true)
    const row = await fx.db.get<{ docstatus: number }>(`SELECT docstatus FROM bills WHERE id = ?`, [may])
    expect(row!.docstatus).toBe(1)
  })

  it('cancelling a payment in it', async () => {
    const customer = await makeCustomer(fx.db)
    await sale('2026-05-10', customer, true)
    const paid = await recordPayment(fx.db, {
      customerId: customer, amount: rupees(100) as Money, method: 'cash', actorId: fx.adminId,
      now: new Date('2026-05-20T10:00:00'),
    })
    if (!paid.ok) throw new Error(paid.code)
    await closeMay()
    expect(await cancelPayment(fx.db, { paymentId: paid.paymentId, actorId: fx.adminId })).toEqual(REFUSED)
  })

  it('cancelling a return in it', async () => {
    const may = await sale('2026-05-10')
    const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [may])
    const ret = await processReturn(fx.db, {
      billId: may, lines: [{ billItemId: item!.id, qty: fromUnits(1) }], refundMethod: 'cash',
      actorId: fx.adminId, now: new Date('2026-05-12T10:00:00'),
    })
    if (!ret.ok) throw new Error(ret.code)
    await closeMay()
    expect(await cancelReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })).toEqual(REFUSED)
  })

  it('posting goods backdated into it, and cancelling goods posted in it', async () => {
    const backdated = await createStockEntry(fx.db, {
      entryType: 'purchase', postingDate: '2026-05-20',
      lines: [{ productId: product, qty: fromUnits(5), unitCost: rupees(50) }], actorId: fx.adminId,
    })
    if (!backdated.ok) throw new Error(backdated.code)
    await closeMay()
    expect(await submitStockEntry(fx.db, { entryId: backdated.entryId, actorId: fx.adminId })).toEqual(REFUSED)

    const opening = await fx.db.get<{ id: string }>(`SELECT id FROM stock_entries WHERE entry_type = 'opening'`)
    expect(await cancelStockEntry(fx.db, { entryId: opening!.id, actorId: fx.adminId })).toEqual(REFUSED)
  })

  it('an opening balance dated into it, for a customer or a supplier', async () => {
    await closeMay()
    const customer = await makeCustomer(fx.db)
    expect(await recordOpeningBalance(fx.db, {
      customerId: customer, amount: rupees(500) as Money, asOf: '2026-03-31',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })).toEqual(REFUSED)

    const supplier = await createSupplier(fx.db, { name: 'Ramesh Traders', actorId: fx.adminId })
    if (!supplier.ok) throw new Error('no supplier')
    expect(await setSupplierOpening(fx.db, { actorId: fx.adminId }, {
      supplierId: supplier.supplierId, amount: rupees(500) as Money, asOf: '2026-03-31',
    })).toEqual(REFUSED)
  })
})

describe('a stock count', () => {
  async function mayCount(): Promise<string> {
    const opened = await openCount(fx.db, {
      scope: { kind: 'chosen', productIds: [product] }, actorId: fx.adminId,
      now: new Date('2026-05-30T18:00:00'),
    })
    if (!opened.ok) throw new Error(opened.code)
    await setCounted(fx.db, { countId: opened.countId, productId: product, countedQty: fromUnits(90) })
    return opened.countId
  }

  it('opened in a closed period cannot be posted, and moves nothing', async () => {
    const countId = await mayCount()
    await closeMay()
    expect(await submitCount(fx.db, { countId, actorId: fx.adminId })).toEqual(REFUSED)
    expect(await fx.db.query(`SELECT id FROM stock_entries WHERE entry_type = 'adjustment'`)).toEqual([])
  })

  it('posted in a closed period cannot be reversed, but an unposted sheet can always be thrown away', async () => {
    const posted = await mayCount()
    const done = await submitCount(fx.db, { countId: posted, actorId: fx.adminId })
    if (!done.ok) throw new Error(done.code)
    const thrown = await mayCount()
    await closeMay()
    expect(await cancelCount(fx.db, { countId: posted, actorId: fx.adminId })).toEqual(REFUSED)
    expect(await cancelCount(fx.db, { countId: thrown, actorId: fx.adminId })).toEqual({ ok: true })
  })
})

describe('what a closed period never refuses', () => {
  it('the counter taking money today, even when the date was set wrong on another till', async () => {
    // Written straight into the setting, as a sync from a till with a bad clock would.
    await setSetting(fx.db, 'books_closed_through', '2026-12-31')
    const today = await sale('2026-06-15')
    expect(today).toBeTruthy()
  })
})
