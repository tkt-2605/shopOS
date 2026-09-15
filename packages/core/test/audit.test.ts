import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listAuditEntries, auditEntities, auditActors } from '../src/repos/audit.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { setItemPrice } from '../src/services/pricing.js'
import { postMovement } from '../src/services/stock.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { SUBMITTED, CANCELLED } from '../src/integrity/docstatus.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId, qtyChange: fromUnits(units), unitCost: rupees(50) as Money,
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    })
  })
}

async function aCancelledBill(): Promise<string> {
  const p = await makeProduct(fx.db, { baseRate: rupees(100) })
  await stockUp(fx.db, p, 10)
  const bill = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: p, qty: fromUnits(1) }], actorId: fx.adminId,
  })
  if (!bill.ok) throw new Error(bill.code)
  await submitBill(fx.db, {
    billId: bill.billId, payments: [{ method: 'cash', amount: bill.grandTotal }], actorId: fx.adminId,
  })
  await cancelBill(fx.db, { billId: bill.billId, reason: 'wrong item', actorId: fx.adminId })
  return bill.billId
}

describe('the history of a document', () => {
  it('reads newest first', async () => {
    const billId = await aCancelledBill()
    const entries = await listAuditEntries(fx.db, { entityId: billId })
    expect(entries.map((e) => e.action)).toEqual(['cancel', 'submit', 'create'])
  })

  it('says who did it and what it was called', async () => {
    const billId = await aCancelledBill()
    const [cancelled] = await listAuditEntries(fx.db, { entityId: billId })

    expect(cancelled?.actorName).toBe('Administrator')
    // The bill's own number, joined rather than copied into the log.
    expect(cancelled?.subject).toMatch(/^BMR\//)
  })

  it('shows the document moving between states', async () => {
    const billId = await aCancelledBill()
    const [cancelled] = await listAuditEntries(fx.db, { entityId: billId })
    expect(cancelled?.docstatusFrom).toBe(SUBMITTED)
    expect(cancelled?.docstatusTo).toBe(CANCELLED)
  })
})

describe('what changed, from what to what', () => {
  it('names the field and both values', async () => {
    const p = await makeProduct(fx.db, { name: 'Notebook' })
    const first = await setItemPrice(fx.db, { actorId: fx.adminId }, {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(9),
    })
    if (!first.ok) throw new Error(first.code)
    await setItemPrice(fx.db, { actorId: fx.adminId }, {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(7),
    })

    const [changed] = await listAuditEntries(fx.db, { entity: 'item_prices' })
    expect(changed?.action).toBe('update')
    const rate = changed?.changes.find((c) => c.field === 'rate')
    expect(rate?.from).toBe(rupees(9))
    expect(rate?.to).toBe(rupees(7))
    // And which item it was, so the line reads as a sentence.
    expect(changed?.subject).toBe('Notebook')
  })

  it('is empty rather than invented when there is nothing to compare', async () => {
    await aCancelledBill()
    const [entry] = await listAuditEntries(fx.db, { entity: 'bills', action: 'create' })
    expect(entry?.changes).toEqual([])
  })
})

describe('finding one change among thousands', () => {
  it('filters by what was touched', async () => {
    await aCancelledBill()
    const bills = await listAuditEntries(fx.db, { entity: 'bills' })
    expect(bills.every((e) => e.entity === 'bills')).toBe(true)
    expect(bills.length).toBeGreaterThan(0)
  })

  it('filters by what was done', async () => {
    await aCancelledBill()
    const cancels = await listAuditEntries(fx.db, { action: 'cancel' })
    expect(cancels).toHaveLength(1)
  })

  it('filters by who', async () => {
    await aCancelledBill()
    expect(await listAuditEntries(fx.db, { actorId: fx.adminId })).not.toHaveLength(0)
    expect(await listAuditEntries(fx.db, { actorId: newId() })).toHaveLength(0)
  })

  /* A date without a time is a day, and "up to the 13th" means the end of it. */
  it('includes the whole of the last day asked for', async () => {
    const billId = await aCancelledBill()
    const at = (await listAuditEntries(fx.db, { entityId: billId }))[0]!.at
    const day = at.slice(0, 10)

    expect(await listAuditEntries(fx.db, { from: day, to: day })).not.toHaveLength(0)
  })

  it('searches the names a person would recognise', async () => {
    const p = await makeProduct(fx.db, { name: 'Camlin geometry box' })
    await setItemPrice(fx.db, { actorId: fx.adminId }, {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(9),
    })

    const found = await listAuditEntries(fx.db, { term: 'geometry' })
    expect(found.map((f) => f.subject)).toContain('Camlin geometry box')
  })

  it('offers only the filters that have something behind them', async () => {
    await aCancelledBill()
    expect(await auditEntities(fx.db)).toContain('bills')
    expect((await auditActors(fx.db)).map((a) => a.name)).toEqual(['Administrator'])
  })

  it('pages without repeating a row', async () => {
    await aCancelledBill()
    const first = await listAuditEntries(fx.db, { limit: 2, offset: 0 })
    const second = await listAuditEntries(fx.db, { limit: 2, offset: 2 })
    const ids = new Set([...first, ...second].map((e) => e.id))
    expect(ids.size).toBe(first.length + second.length)
  })
})
