import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { businessDate } from '../src/dates.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { getOrOpenSession, postCashMovement, sessionMovements } from '../src/services/cash.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { createPriceList, setCustomerPriceList, customerPriceListId } from '../src/services/pricing.js'
import { loadCustomer } from '../src/repos/catalog.js'
import { lowStock } from '../src/repos/lowStock.js'
import { daySales } from '../src/repos/reports.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * The queries the screens used to write for themselves, now asked of the core.
 *
 * Five places in the app held their own SQL: the cash counter's list of
 * movements, the dashboard's takings and its low-stock list, the customer's
 * price list on the pricing screen, and the customer on a printed or saved
 * statement. Each moved into the core as a typed query, and each is held here
 * to the statement it replaced -- run against the same database, the old SQL
 * and the new function must give the same answer, row for row.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockIn(productId: string, units: number) {
  const e = await createStockEntry(fx.db, {
    entryType: 'purchase',
    lines: [{ productId, qty: fromUnits(units), unitCost: rupees(10) }],
    supplierName: 'Acme',
    actorId: fx.adminId,
  })
  if (!e.ok) throw new Error(e.code)
  await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
}

async function sell(productId: string, units: number, sessionId?: string) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(sessionId ? { sessionId } : {}),
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const r = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!r.ok) throw new Error(`submit failed: ${r.code}`)
  return draft.grandTotal
}

describe('the dashboard', () => {
  it("counts today's takings as the screen's own query did", async () => {
    const product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockIn(product, 50)
    const a = await sell(product, 2)
    const b = await sell(product, 3)
    // A draft is not a sale.
    await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
    })

    const today = businessDate()
    const old = await fx.db.get<{ total: number; n: number }>(
      `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS n
         FROM bills WHERE docstatus = 1 AND posting_date = ?`,
      [today],
    )
    const now = await daySales(fx.db, today)

    expect(now).toEqual({ total: old!.total, bills: old!.n })
    expect(now).toEqual({ total: a + b, bills: 2 })
  })

  it('answers zero for a day with nothing sold, not null', async () => {
    expect(await daySales(fx.db, '2001-01-01')).toEqual({ total: 0, bills: 0 })
  })

  it('lists the low-stock items the screen listed, in the same order', async () => {
    const few = await makeProduct(fx.db, { name: 'Few' })
    const none = await makeProduct(fx.db, { name: 'Never stocked' })
    const plenty = await makeProduct(fx.db, { name: 'Plenty' })
    const some = await makeProduct(fx.db, { name: 'Some' })
    await stockIn(few, 2)
    await stockIn(plenty, 40)
    await stockIn(some, 7)
    void none

    const below = fromUnits(10)
    const old = await fx.db.query<{ name: string; qty: number; base_unit: string }>(
      `SELECT p.name, COALESCE(ps.qty_on_hand, 0) AS qty, p.base_unit
         FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id
        WHERE p.is_active = 1 AND p.deleted_at IS NULL AND p.is_stock_tracked = 1
          AND COALESCE(ps.qty_on_hand, 0) < ?
        ORDER BY qty LIMIT 12`,
      [below],
    )
    const now = await lowStock(fx.db, { below, limit: 12 })

    expect(now).toEqual(old.map((r) => ({ name: r.name, qty: r.qty, unit: r.base_unit })))
    expect(now.map((r) => r.name)).toEqual(['Never stocked', 'Few', 'Some'])
  })

  it('stops at the limit', async () => {
    for (let i = 0; i < 5; i++) await makeProduct(fx.db, { name: `P${i}` })
    expect(await lowStock(fx.db, { below: fromUnits(1), limit: 3 })).toHaveLength(3)
  })
})

describe('the cash counter', () => {
  it("lists a drawer's movements as the screen's own query did, newest first", async () => {
    const product = await makeProduct(fx.db, { baseRate: rupees(50), taxRateBp: 0 })
    await stockIn(product, 20)
    const { sessionId: session } = await getOrOpenSession(fx.db, {
      registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(500),
    })
    await sell(product, 1, session)
    await postCashMovement(fx.db, {
      sessionId: session, direction: 'out', amount: rupees(20), method: 'cash',
      sourceType: 'payout', sourceId: null, reference: 'tea', userId: fx.adminId,
      now: new Date(Date.now() + 1000),
    })

    const old = await fx.db.query<{
      id: string; direction: string; amount: number; method: string
      source_type: string; reference: string | null; created_at: string
    }>(
      `SELECT id, direction, amount, method, source_type, reference, created_at
         FROM cash_movements WHERE session_id = ? ORDER BY created_at DESC LIMIT 60`, [session],
    )
    const now = await sessionMovements(fx.db, session)

    expect(now).toEqual(old.map((m) => ({
      id: m.id, direction: m.direction, amount: m.amount, method: m.method,
      sourceType: m.source_type, reference: m.reference, createdAt: m.created_at,
    })))
    expect(now.length).toBeGreaterThanOrEqual(2)
    expect(now[0]!.reference).toBe('tea')
  })
})

describe('the customer on a statement and on the pricing screen', () => {
  it('reads the name, code, phone and address the statement printed', async () => {
    const id = await makeCustomer(fx.db, 'Meena Stores')
    await fx.db.execute(
      `UPDATE customers SET code = 'C-7', phone = '9840000000', address = '12 Car Street' WHERE id = ?`, [id],
    )
    const old = await fx.db.get<{ name: string; code: string | null; phone: string | null; address: string | null }>(
      `SELECT name, code, phone, address FROM customers WHERE id = ?`, [id],
    )
    const now = await loadCustomer(fx.db, id)

    expect(now && { name: now.name, code: now.code, phone: now.phone, address: now.address }).toEqual(old)
    expect(await loadCustomer(fx.db, 'nobody')).toBeNull()
  })

  it("reads the list a customer buys from, and null when they have none", async () => {
    const id = await makeCustomer(fx.db)
    expect(await customerPriceListId(fx.db, id)).toBeNull()

    const list = await createPriceList(fx.db, { actorId: fx.adminId }, { name: 'Wholesale' })
    if (!list.ok) throw new Error(list.code)
    await setCustomerPriceList(fx.db, { actorId: fx.adminId }, id, list.priceListId)

    const old = await fx.db.get<{ price_list_id: string | null }>(
      `SELECT price_list_id FROM customers WHERE id = ?`, [id],
    )
    expect(await customerPriceListId(fx.db, id)).toBe(old?.price_list_id)
    expect(await customerPriceListId(fx.db, id)).toBe(list.priceListId)
  })
})
