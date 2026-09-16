import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { postMovement, stockValue, recomputeStock, reverseVoucher, issuedUnitCost } from '../src/services/stock.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { createReturn, submitReturn } from '../src/services/returns.js'
import { newId } from '../src/ids.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { migrate } from '../src/db/migrate.js'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function receive(db: SqlDriver, productId: string, units: number, unitCost: Money): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost,
      voucherType: 'stock_entry',
      voucherId: newId(),
      postingDate: '2026-01-01',
    })
  })
}

describe('running stock value', () => {
  it('averages two purchases at different prices', async () => {
    const p = await makeProduct(fx.db)
    await receive(fx.db, p, 10, rupees(40))
    await receive(fx.db, p, 10, rupees(60))

    const held = await stockValue(fx.db, p)
    expect(toUnits(held.qty)).toBe(20)
    expect(held.value).toBe(rupees(1000))
    expect(held.unitCost).toBe(rupees(50))
  })

  it('values goods going out at the average, leaving the rate unchanged', async () => {
    const p = await makeProduct(fx.db)
    await receive(fx.db, p, 10, rupees(40))
    await receive(fx.db, p, 10, rupees(60))

    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(-4), voucherType: 'bill',
        voucherId: newId(), postingDate: '2026-01-02',
      })
    })

    const held = await stockValue(fx.db, p)
    expect(toUnits(held.qty)).toBe(16)
    expect(held.value).toBe(rupees(800))
    expect(held.unitCost).toBe(rupees(50))
  })

  it('stamps the cost onto the sale movement, so profit needs no replay', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await receive(fx.db, p, 20, rupees(60))

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(3) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })

    expect(await issuedUnitCost(fx.db, 'bill', draft.billId, p)).toBe(rupees(60))
  })

  it('leaves nothing behind when the last unit goes out', async () => {
    const p = await makeProduct(fx.db)
    await receive(fx.db, p, 3, rupees(33.33))

    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(-3), voucherType: 'bill',
        voucherId: newId(), postingDate: '2026-01-02',
      })
    })

    const held = await stockValue(fx.db, p)
    expect(held.qty).toBe(0)
    expect(held.value).toBe(0)
    expect(held.unitCost).toBeNull()
  })

  it('puts returned goods back at what they cost, not at today’s average', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await receive(fx.db, p, 10, rupees(40))

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(4) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })

    // Prices went up between the sale and the return.
    await receive(fx.db, p, 6, rupees(90))

    const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [draft.billId])
    const ret = await createReturn(fx.db, {
      billId: draft.billId,
      lines: [{ billItemId: item!.id, qty: fromUnits(4) }],
      refundMethod: 'cash',
      actorId: fx.adminId,
    })
    if (!ret.ok) throw new Error('return failed')
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })

    const held = await stockValue(fx.db, p)
    expect(toUnits(held.qty)).toBe(16)
    // 6 units at 40 + 6 at 90 + 4 back at the 40 they left at.
    expect(held.value).toBe(rupees(940))
  })

  it('restores the exact value a cancelled bill took out', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await receive(fx.db, p, 10, rupees(40))
    const before = await stockValue(fx.db, p)

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(3) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })
    await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId, reason: 'test' })

    expect(await stockValue(fx.db, p)).toEqual(before)
  })

  it('reports value drift as well as quantity drift, and repairs both', async () => {
    const p = await makeProduct(fx.db)
    await receive(fx.db, p, 10, rupees(40))

    expect(await recomputeStock(fx.db)).toEqual([])

    await fx.db.execute(`UPDATE product_stock SET stock_value = 1 WHERE product_id = ?`, [p])
    const drift = await recomputeStock(fx.db)
    expect(drift).toHaveLength(1)
    expect(drift[0]!.cachedValue).toBe(1)
    expect(drift[0]!.actualValue).toBe(rupees(400))

    expect(await recomputeStock(fx.db, { repair: true })).toHaveLength(1)
    expect(await recomputeStock(fx.db)).toEqual([])
  })

  it('has no opinion about goods received without a cost', async () => {
    const p = await makeProduct(fx.db)
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(5), voucherType: 'opening',
        voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    const held = await stockValue(fx.db, p)
    expect(toUnits(held.qty)).toBe(5)
    expect(held.unitCost).toBeNull()
  })
})

describe('reversal', () => {
  it('returns a voucher’s goods at the cost they left at', async () => {
    const p = await makeProduct(fx.db)
    await receive(fx.db, p, 10, rupees(50))
    const voucher = newId()

    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(-4), voucherType: 'bill',
        voucherId: voucher, postingDate: '2026-01-02',
      })
    })
    await receive(fx.db, p, 10, rupees(150))

    await fx.db.transaction(async (tx) => {
      await reverseVoucher(tx, 'bill', voucher, '2026-01-03')
    })

    const held = await stockValue(fx.db, p)
    expect(toUnits(held.qty)).toBe(20)
    // 6 at 50 + 10 at 150 + 4 back at 50.
    expect(held.value).toBe(rupees(2000))
  })
})

describe('upgrading a shop that already has stock', () => {
  /* The column arrives with DEFAULT 0, which for a running total is not a neutral
     starting point — it is a claim that the goods cost nothing. Run the real
     migration over a database that stopped at version 1.

     No `bootstrap` here: it writes at head, and the app only ever calls it
     after `migrate` has run. What this fixture needs is the stock a shop had
     before the upgrade, which is the two rows below. */
  it('backfills the cache from the ledger, so the first sale after an upgrade is costed', async () => {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version === 1))

    const productId = newId()
    const now = new Date().toISOString()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES (?, 'A4 Paper', 30000, 0, ?, ?)`,
      [productId, now, now],
    )
    // Stock received the way version 1 recorded it: a ledger row with a cost, and
    // a cache that knew only the quantity.
    await db.execute(
      `INSERT INTO stock_ledger
         (id, product_id, posting_date, qty_change, unit_cost, balance_qty, voucher_type, voucher_id, created_at)
       VALUES (?, ?, '2026-01-01', ?, ?, ?, 'stock_entry', ?, ?)`,
      [newId(), productId, fromUnits(10), rupees(40), fromUnits(10), newId(), now],
    )
    await db.execute(
      `INSERT INTO product_stock (product_id, qty_on_hand, updated_at) VALUES (?, ?, ?)`,
      [productId, fromUnits(10), now],
    )

    await migrate(db, MIGRATIONS)

    const held = await stockValue(db, productId)
    expect(held.value).toBe(rupees(400))
    expect(held.unitCost).toBe(rupees(40))
    expect(await recomputeStock(db)).toEqual([])
    await db.close()
  })

  it('leaves a product with nothing on hand at zero', async () => {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version === 1))

    const productId = newId()
    const now = new Date().toISOString()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES (?, 'Sold Out', 30000, 0, ?, ?)`,
      [productId, now, now],
    )
    await db.execute(
      `INSERT INTO product_stock (product_id, qty_on_hand, updated_at) VALUES (?, 0, ?)`,
      [productId, now],
    )

    await migrate(db, MIGRATIONS)
    expect((await stockValue(db, productId)).value).toBe(0)
    await db.close()
  })
})
