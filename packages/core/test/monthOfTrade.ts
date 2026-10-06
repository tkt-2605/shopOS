import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { processReturn, cancelReturn } from '../src/services/returns.js'
import { recordPayment, cancelPayment } from '../src/services/payments.js'
import { recordOpeningBalance, writeOff } from '../src/services/payments/khata.js'
import { refundAdvance } from '../src/services/payments/advance.js'
import { createStockEntry, submitStockEntry, cancelStockEntry } from '../src/services/stockEntry.js'
import { getOrOpenSession, closeSession, recordPayout } from '../src/services/cash.js'
import { createSupplier, setSupplierOpening } from '../src/services/suppliers.js'
import { paySupplier } from '../src/services/payables.js'
import { setUnits } from '../src/services/pricing.js'
import { setSetting } from '../src/services/settings.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * A month of a shop's trade through the services: every kind of document the
 * books post, each submitted and some cancelled, on dates of their own.
 *
 * `step` is called after each document, so a caller can do something between
 * them -- sync a second till, as `syncInAnyOrder.test.ts` does.
 */
export async function aMonthOfTrade(fx: Fixture, step: () => Promise<void> = async () => {}): Promise<void> {
  const db = fx.db
  const actorId = fx.adminId
  const day = (d: string) => new Date(`${d}T11:00:00`)
  const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error(JSON.stringify(r))
    return r as Extract<T, { ok: true }>
  }

  await setSetting(db, 'shop_state_code', '33')
  await setSetting(db, 'shop_gstin', '33ALNPJ1906G1ZC')
  const pen = await makeProduct(db, { name: 'Pen', baseRate: rupees(118), taxRateBp: 1800 })
  must(await setUnits(db, { actorId }, pen, [{ saleUnit: 'box', baseUnits: fromUnits(10) }]))
  const customer = await makeCustomer(db, 'Anand')
  const mill = must(await createSupplier(db, { name: 'Mill', gstin: '33AAACM1234A1Z5', actorId })).supplierId
  await step()

  must(await setSupplierOpening(db, { actorId }, { supplierId: mill, amount: rupees(500) as Money, asOf: '2026-05-31' }))
  await step()
  const bought = must(await createStockEntry(db, {
    entryType: 'purchase', supplierId: mill, postingDate: '2026-06-01',
    supplierInvoiceNo: 'M-101', supplierInvoiceDate: '2026-06-01',
    lines: [{ productId: pen, qty: fromUnits(200), unitCost: rupees(50), taxRateBp: 1800 }], actorId,
  }))
  must(await submitStockEntry(db, { entryId: bought.entryId, actorId }))
  await step()
  must(await paySupplier(db, { supplierId: mill, amount: rupees(2000) as Money, method: 'upi', actorId }))
  await step()

  await getOrOpenSession(db, { registerId: fx.seed.registerId, userId: actorId, openingCash: rupees(500) as Money, now: day('2026-06-02') })
  const sale = async (units: number, on: string, how: 'cash' | 'upi' | 'credit' = 'cash', saleUnit?: string) => {
    const draft = must(await createBill(db, {
      registerId: fx.seed.registerId, lines: [{ productId: pen, qty: fromUnits(units), ...(saleUnit ? { saleUnit } : {}) }],
      ...(how === 'credit' ? { customerId: customer } : {}), actorId, now: day(on),
    }))
    must(await submitBill(db, { billId: draft.billId, payments: [{ method: how, amount: draft.grandTotal }], actorId, now: day(on) }))
    await step()
    return draft.billId
  }

  const counter = await sale(3, '2026-06-02')
  await sale(2, '2026-06-03', 'upi')
  await sale(1, '2026-06-03', 'cash', 'box')

  const line = await db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [counter])
  const undoneReturn = must(await processReturn(db, {
    billId: counter, lines: [{ billItemId: line!.id, qty: fromUnits(1) }], refundMethod: 'cash', actorId, now: day('2026-06-03'),
  }))
  await step()
  must(await cancelReturn(db, { returnId: undoneReturn.returnId, actorId }))
  await step()

  const onCredit = await sale(4, '2026-06-04', 'credit')
  const cancelled = await sale(1, '2026-06-05')
  must(await cancelBill(db, { billId: cancelled, actorId }))
  await step()

  const item = await db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [onCredit])
  must(await processReturn(db, {
    billId: onCredit, lines: [{ billItemId: item!.id, qty: fromUnits(1) }], refundMethod: 'credit', actorId, now: day('2026-06-06'),
  }))
  await step()

  must(await recordPayment(db, { customerId: customer, amount: rupees(200) as Money, method: 'cash', actorId, now: day('2026-06-07') }))
  await step()
  const undone = must(await recordPayment(db, { customerId: customer, amount: rupees(10) as Money, method: 'upi', actorId, now: day('2026-06-07') }))
  must(await cancelPayment(db, { paymentId: undone.paymentId, actorId }))
  await step()
  await writeOff(db, { customerId: customer, amount: rupees(4) as Money, reason: 'Small balance', actorId })
  await step()

  const other = await makeCustomer(db, 'Bhavani')
  await recordOpeningBalance(db, { customerId: other, amount: rupees(300) as Money, asOf: '2026-06-01', registerId: fx.seed.registerId, actorId })
  const holding = await makeCustomer(db, 'Chitra')
  await recordOpeningBalance(db, { customerId: holding, amount: -rupees(150) as Money, asOf: '2026-06-01', registerId: fx.seed.registerId, actorId })
  await refundAdvance(db, { customerId: holding, amount: rupees(50) as Money, method: 'cash', actorId })
  await step()

  const waste = must(await createStockEntry(db, {
    entryType: 'wastage', postingDate: '2026-06-08', lines: [{ productId: pen, qty: fromUnits(-2) }], actorId,
  }))
  must(await submitStockEntry(db, { entryId: waste.entryId, actorId }))
  await step()
  const wrong = must(await createStockEntry(db, {
    entryType: 'purchase', supplierId: mill, postingDate: '2026-06-09',
    supplierInvoiceNo: 'M-102', supplierInvoiceDate: '2026-06-09',
    lines: [{ productId: pen, qty: fromUnits(10), unitCost: rupees(52), taxRateBp: 1800 }], actorId,
  }))
  must(await submitStockEntry(db, { entryId: wrong.entryId, actorId }))
  await step()
  must(await cancelStockEntry(db, { entryId: wrong.entryId, actorId }))
  await step()

  const session = await db.get<{ id: string }>(`SELECT id FROM cash_sessions WHERE closed_at IS NULL`)
  await recordPayout(db, { sessionId: session!.id, amount: rupees(30) as Money, reason: 'Tea', userId: actorId })
  await step()
  await closeSession(db, { sessionId: session!.id, actualCash: rupees(800) as Money, userId: actorId, now: day('2026-06-10') })
  await step()
}
