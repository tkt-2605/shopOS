import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  openCount, loadCount, listCounts, openSheet, setCounted, submitCount, cancelCount,
} from '../src/services/stockCount.js'
import { currentStock, postMovement, stockValue } from '../src/services/stock.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, toUnits, qty, QTY_ZERO } from '../src/quantity.js'
import { SUBMITTED, CANCELLED } from '../src/integrity/docstatus.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number, cost = 5000): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost: cost as Money,
      voucherType: 'opening',
      voucherId: newId(),
      postingDate: '2026-01-01',
    })
  })
}

async function sheetFor(productId: string) {
  const opened = await openCount(fx.db, { scope: { kind: 'chosen', productIds: [productId] }, actorId: fx.adminId })
  if (!opened.ok) throw new Error(opened.code)
  return opened
}

describe('opening a sheet', () => {
  it('freezes what the system believes right now', async () => {
    const p = await makeProduct(fx.db, { name: 'Notebook' })
    await stockUp(fx.db, p, 14)

    const opened = await sheetFor(p)
    const sheet = await loadCount(fx.db, opened.countId)
    expect(toUnits(sheet!.lines[0]!.expectedQty)).toBe(14)
    expect(sheet!.lines[0]!.countedQty).toBeNull()
  })

  it('records what a unit was worth, so found goods come back at that price', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 10, rupees(50))

    const sheet = await loadCount(fx.db, (await sheetFor(p)).countId)
    expect(sheet!.lines[0]!.unitCost).toBe(rupees(50))
  })

  it('leaves out what the system thinks is not there', async () => {
    const stocked = await makeProduct(fx.db, { name: 'On the shelf' })
    await makeProduct(fx.db, { name: 'Never stocked' })
    await stockUp(fx.db, stocked, 3)

    const opened = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId })
    if (!opened.ok) throw new Error(opened.code)
    const sheet = await loadCount(fx.db, opened.countId)
    expect(sheet!.lines.map((l) => l.productName)).toEqual(['On the shelf'])
  })

  it('includes the empty shelves when asked, which is how a shop finds what it has run out of', async () => {
    await makeProduct(fx.db, { name: 'Run out' })
    const opened = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId, includeEmpty: true })
    if (!opened.ok) throw new Error(opened.code)
    expect(opened.lineCount).toBe(1)
  })

  /* Two sheets over the same shelf would each post their own difference, and the
     same correction would be applied twice. */
  it('refuses a second sheet while one is open', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 5)
    const first = await sheetFor(p)

    const second = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId })
    if (second.ok || second.code !== 'ALREADY_OPEN') throw new Error('expected the open sheet to block it')
    expect(second.countId).toBe(first.countId)
    expect((await openSheet(fx.db))?.docNo).toBe(first.docNo)
  })

  it('refuses when there is nothing in scope', async () => {
    const r = await openCount(fx.db, { scope: { kind: 'chosen', productIds: [] }, actorId: fx.adminId })
    expect(r.ok).toBe(false)
  })
})

describe('counting', () => {
  it('tells a counted zero apart from an uncounted line', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 4)
    const { countId } = await sheetFor(p)

    await setCounted(fx.db, { countId, productId: p, countedQty: QTY_ZERO })
    expect((await loadCount(fx.db, countId))!.lines[0]!.countedQty).toBe(0)

    await setCounted(fx.db, { countId, productId: p, countedQty: null })
    expect((await loadCount(fx.db, countId))!.lines[0]!.countedQty).toBeNull()
  })

  it('refuses a negative count', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 4)
    const { countId } = await sheetFor(p)
    await expect(setCounted(fx.db, { countId, productId: p, countedQty: qty(-1) })).rejects.toThrow()
  })

  it('will not take a count against a submitted sheet', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 4)
    const { countId } = await sheetFor(p)
    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(4) })
    await submitCount(fx.db, { countId, actorId: fx.adminId })

    await expect(setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(9) }))
      .rejects.toThrow(/already been submitted/)
  })
})

describe('submitting what was found', () => {
  it('writes the shortage into stock', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 14)
    const { countId } = await sheetFor(p)
    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(12) })

    const result = await submitCount(fx.db, { countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)

    expect(result.adjusted).toBe(1)
    expect(result.shortages).toBe(1)
    expect(toUnits(await currentStock(fx.db, p))).toBe(12)
  })

  it('writes a surplus back in at what the shelf was worth, not at nothing', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 10, rupees(50))
    const { countId } = await sheetFor(p)
    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(12) })

    const result = await submitCount(fx.db, { countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)
    expect(result.surpluses).toBe(1)

    const after = await stockValue(fx.db, p)
    expect(toUnits(after.qty)).toBe(12)
    // Twelve units still worth ₹50 each: a count corrects a quantity and must
    // not move the average.
    expect(after.unitCost).toBe(rupees(50))
    expect(after.value).toBe(rupees(600))
  })

  it('posts only the lines that differ', async () => {
    const right = await makeProduct(fx.db, { name: 'Agrees' })
    const wrong = await makeProduct(fx.db, { name: 'Differs' })
    await stockUp(fx.db, right, 5)
    await stockUp(fx.db, wrong, 5)

    const opened = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId })
    if (!opened.ok) throw new Error(opened.code)
    await setCounted(fx.db, { countId: opened.countId, productId: right, countedQty: fromUnits(5) })
    await setCounted(fx.db, { countId: opened.countId, productId: wrong, countedQty: fromUnits(3) })

    const result = await submitCount(fx.db, { countId: opened.countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)
    expect(result.adjusted).toBe(1)

    const rows = await fx.db.query<{ product_id: string }>(
      `SELECT product_id FROM stock_ledger WHERE voucher_id = ?`, [result.entryId],
    )
    expect(rows.map((r) => r.product_id)).toEqual([wrong])
  })

  it('ignores lines nobody counted', async () => {
    const counted = await makeProduct(fx.db, { name: 'Counted' })
    const skipped = await makeProduct(fx.db, { name: 'Skipped' })
    await stockUp(fx.db, counted, 5)
    await stockUp(fx.db, skipped, 5)

    const opened = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId })
    if (!opened.ok) throw new Error(opened.code)
    await setCounted(fx.db, { countId: opened.countId, productId: counted, countedQty: fromUnits(4) })

    const result = await submitCount(fx.db, { countId: opened.countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)
    // An untouched line is not a claim that the shelf is empty.
    expect(toUnits(await currentStock(fx.db, skipped))).toBe(5)
  })

  it('submits with no adjustment at all when everything agrees', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 7)
    const { countId } = await sheetFor(p)
    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(7) })

    const result = await submitCount(fx.db, { countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)
    expect(result.entryId).toBeNull()
    expect(result.adjusted).toBe(0)
    expect((await loadCount(fx.db, countId))!.docstatus).toBe(SUBMITTED)
  })

  it('refuses a sheet where nothing was counted', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 7)
    const { countId } = await sheetFor(p)
    const result = await submitCount(fx.db, { countId, actorId: fx.adminId })
    expect(result.ok).toBe(false)
  })

  it('leaves the count traceable to the adjustment it produced', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 10)
    const { countId, docNo } = await sheetFor(p)
    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(8) })

    const result = await submitCount(fx.db, { countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)

    const entry = await fx.db.get<{ reference: string; entry_type: string }>(
      `SELECT reference, entry_type FROM stock_entries WHERE id = ?`, [result.entryId],
    )
    expect(entry?.reference).toBe(docNo)
    expect(entry?.entry_type).toBe('adjustment')
    expect((await loadCount(fx.db, countId))!.entryId).toBe(result.entryId)
  })
})

/**
 * The case the whole design exists for: the shop does not stop selling while
 * someone counts the back shelf.
 */
describe('a sale while the counting is happening', () => {
  it('is kept, because the difference is posted rather than the count', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 14)

    // The sheet says 14, and the counter finds 12 — a shortage of two.
    const { countId } = await sheetFor(p)
    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(12) })

    // Meanwhile three are sold at the till.
    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(3) }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)
    await submitBill(fx.db, {
      billId: bill.billId,
      payments: [{ method: 'cash', amount: bill.grandTotal }],
      actorId: fx.adminId,
    })
    expect(toUnits(await currentStock(fx.db, p))).toBe(11)

    const result = await submitCount(fx.db, { countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)

    // 11 on the system less the two that were genuinely missing: 9.
    // Setting the counted 12 absolutely would have put the three sold ones back.
    expect(toUnits(await currentStock(fx.db, p))).toBe(9)
  })

  it('says which lines moved, so the shopkeeper is not left wondering', async () => {
    const p = await makeProduct(fx.db, { name: 'Sold while counting', baseRate: rupees(100) })
    const still = await makeProduct(fx.db, { name: 'Untouched' })
    await stockUp(fx.db, p, 10)
    await stockUp(fx.db, still, 10)

    const opened = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId })
    if (!opened.ok) throw new Error(opened.code)
    await setCounted(fx.db, { countId: opened.countId, productId: p, countedQty: fromUnits(10) })
    await setCounted(fx.db, { countId: opened.countId, productId: still, countedQty: fromUnits(10) })

    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(2) }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)
    await submitBill(fx.db, {
      billId: bill.billId,
      payments: [{ method: 'cash', amount: bill.grandTotal }],
      actorId: fx.adminId,
    })

    const result = await submitCount(fx.db, { countId: opened.countId, actorId: fx.adminId })
    if (!result.ok) throw new Error(result.code)

    expect(result.moved.map((m) => m.productName)).toEqual(['Sold while counting'])
    expect(toUnits(result.moved[0]!.expectedQty)).toBe(10)
    expect(toUnits(result.moved[0]!.currentQty)).toBe(8)
  })
})

describe('undoing a count', () => {
  it('puts the stock back when a submitted count is cancelled', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 10)
    const { countId } = await sheetFor(p)
    await setCounted(fx.db, { countId, productId: p, countedQty: fromUnits(6) })
    await submitCount(fx.db, { countId, actorId: fx.adminId })
    expect(toUnits(await currentStock(fx.db, p))).toBe(6)

    await cancelCount(fx.db, { countId, reason: 'counted the wrong shelf', actorId: fx.adminId })
    expect(toUnits(await currentStock(fx.db, p))).toBe(10)
    expect((await loadCount(fx.db, countId))!.docstatus).toBe(CANCELLED)
  })

  it('makes an abandoned sheet stop blocking the next one', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 10)
    const { countId } = await sheetFor(p)

    await cancelCount(fx.db, { countId, actorId: fx.adminId })
    expect(await openSheet(fx.db)).toBeNull()

    const again = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId })
    expect(again.ok).toBe(true)
  })
})

describe('the list of counts', () => {
  it('says how much of each sheet is done', async () => {
    const a = await makeProduct(fx.db, { name: 'A' })
    const b = await makeProduct(fx.db, { name: 'B' })
    await stockUp(fx.db, a, 5)
    await stockUp(fx.db, b, 5)

    const opened = await openCount(fx.db, { scope: { kind: 'all' }, actorId: fx.adminId })
    if (!opened.ok) throw new Error(opened.code)
    await setCounted(fx.db, { countId: opened.countId, productId: a, countedQty: fromUnits(4) })

    const [summary] = await listCounts(fx.db)
    expect(summary?.lineCount).toBe(2)
    expect(summary?.countedCount).toBe(1)
    expect(summary?.differenceCount).toBe(1)
  })
})

describe('a count refused at submit', () => {
  it('leaves nothing behind, so trying again does not pile up adjustment drafts', async () => {
    const p = await makeProduct(fx.db, { name: 'Glue stick' })
    await stockUp(fx.db, p, 10)
    const opened = await sheetFor(p)
    await setCounted(fx.db, { countId: opened.countId, productId: p, countedQty: fromUnits(2) })
    // Eight are to come off, but only five are left by the time it is submitted.
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(-5), voucherType: 'probe', voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await submitCount(fx.db, { countId: opened.countId, actorId: fx.adminId }))
        .toMatchObject({ ok: false, code: 'WOULD_GO_NEGATIVE' })
    }
    expect(await fx.db.query(`SELECT id FROM stock_entries`)).toHaveLength(0)
  })
})
