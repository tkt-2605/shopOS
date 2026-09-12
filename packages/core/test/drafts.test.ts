import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { createBill, saveDraft, submitBill } from '../src/services/billing.js'
import { listOpenDrafts, loadDraft, discardDraft, pruneEmptyDrafts } from '../src/services/drafts.js'
import { currentStock, postMovement } from '../src/services/stock.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId, qtyChange: fromUnits(units), unitCost: rupees(50),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    })
  })
}

async function start(productId: string, units = 1) {
  const r = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!r.ok) throw new Error('draft failed')
  return r
}

describe('held bills', () => {
  it('keeps a bill in progress without touching stock or the invoice series', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const draft = await start(p, 3)

    expect(toUnits(await currentStock(fx.db, p))).toBe(20)
    const seq = await fx.db.query(`SELECT * FROM doc_sequences`)
    expect(seq).toHaveLength(0)

    const open = await listOpenDrafts(fx.db, fx.seed.registerId)
    expect(open).toHaveLength(1)
    expect(open[0]!.billId).toBe(draft.billId)
    expect(open[0]!.grandTotal).toBe(rupees(300))
  })

  it('replaces the lines in place, keeping the same bill', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    const q = await makeProduct(fx.db, { name: 'Second', baseRate: rupees(25), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    await stockUp(fx.db, q, 20)
    const draft = await start(p, 1)

    const saved = await saveDraft(fx.db, {
      billId: draft.billId,
      registerId: fx.seed.registerId,
      lines: [
        { productId: p, qty: fromUnits(2) },
        { productId: q, qty: fromUnits(4) },
      ],
      actorId: fx.adminId,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    expect(saved.billId).toBe(draft.billId)
    expect(saved.grandTotal).toBe(rupees(300))
    expect(await listOpenDrafts(fx.db, fx.seed.registerId)).toHaveLength(1)

    const items = await fx.db.query(`SELECT id FROM bill_items WHERE bill_id = ?`, [draft.billId])
    expect(items).toHaveLength(2)
  })

  it('reads back exactly what the cashier had on screen', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId,
      lines: [{ productId: p, qty: fromUnits(3), rateOverride: rupees(90) }],
      billDiscount: rupees(20),
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')

    const loaded = (await loadDraft(fx.db, draft.billId))!
    expect(loaded.customerId).toBe(customerId)
    expect(loaded.customerName).toBe('Sri Vidya School')
    expect(loaded.billDiscount).toBe(rupees(20))
    expect(loaded.lines).toHaveLength(1)
    expect(loaded.lines[0]!.rate).toBe(rupees(90))
    expect(toUnits(loaded.lines[0]!.qty)).toBe(3)
    expect(loaded.lines[0]!.priceSource).toBe('manual_override')
  })

  it('keeps each counter’s held bills to itself', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    await start(p)

    const other = newId()
    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO registers (id, name, prefix, created_at, updated_at) VALUES (?, 'Second', 'SC', ?, ?)`,
      [other, now, now],
    )

    expect(await listOpenDrafts(fx.db, fx.seed.registerId)).toHaveLength(1)
    expect(await listOpenDrafts(fx.db, other)).toHaveLength(0)
  })

  it('holds several bills at once and tells them apart', async () => {
    const pen = await makeProduct(fx.db, { name: 'Ball Pen', baseRate: rupees(10), taxRateBp: 0 })
    const book = await makeProduct(fx.db, { name: 'Note Book', baseRate: rupees(40), taxRateBp: 0 })
    await stockUp(fx.db, pen, 50)
    await stockUp(fx.db, book, 50)

    await start(pen, 2)
    await start(book, 1)

    const open = await listOpenDrafts(fx.db, fx.seed.registerId)
    expect(open).toHaveLength(2)
    expect(open[0]!.preview).toContain('Ball Pen')
    expect(open[1]!.preview).toContain('Note Book')
  })

  it('drops a held bill the customer walked away from', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const draft = await start(p)

    expect(await discardDraft(fx.db, { billId: draft.billId, actorId: fx.adminId })).toEqual({ ok: true })
    expect(await listOpenDrafts(fx.db, fx.seed.registerId)).toHaveLength(0)
    expect(await fx.db.query(`SELECT id FROM bill_items WHERE bill_id = ?`, [draft.billId])).toHaveLength(0)
    expect(toUnits(await currentStock(fx.db, p))).toBe(20)
  })

  it('records the discard before the rows go, so the trail survives it', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const draft = await start(p)
    await discardDraft(fx.db, { billId: draft.billId, actorId: fx.adminId })

    const audit = await fx.db.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_log WHERE entity = 'bills' AND action = 'delete'`,
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.entity_id).toBe(draft.billId)
  })

  it('will not touch a bill that was already rung up', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const draft = await start(p)
    await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })

    expect(await discardDraft(fx.db, { billId: draft.billId, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NOT_A_DRAFT' })

    const save = await saveDraft(fx.db, {
      billId: draft.billId,
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(99) }],
      actorId: fx.adminId,
    })
    expect(save).toEqual({ ok: false, code: 'NOT_A_DRAFT' })

    // And the submitted bill is untouched.
    const item = await fx.db.get<{ qty: number }>(`SELECT qty FROM bill_items WHERE bill_id = ?`, [draft.billId])
    expect(toUnits(item!.qty as never)).toBe(1)
  })

  it('submits a held bill the same as any other', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const draft = await start(p, 2)

    const saved = await saveDraft(fx.db, {
      billId: draft.billId,
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(5) }],
      actorId: fx.adminId,
    })
    if (!saved.ok) throw new Error('save failed')

    const done = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: saved.grandTotal }],
      actorId: fx.adminId,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return

    expect(done.docNo).toMatch(/^INV\/MR\//)
    expect(toUnits(await currentStock(fx.db, p))).toBe(15)
    expect(await listOpenDrafts(fx.db, fx.seed.registerId)).toHaveLength(0)
  })

  it('sweeps up drafts nothing was ever added to', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const kept = await start(p)

    const empty = newId()
    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO bills (id, doc_no, docstatus, register_id, posting_date, created_by, created_at, updated_at)
       VALUES (?, ?, 0, ?, '2026-03-01', ?, ?, ?)`,
      [empty, `DRAFT-${empty}`, fx.seed.registerId, fx.adminId, now, now],
    )

    expect(await pruneEmptyDrafts(fx.db, fx.seed.registerId)).toBe(1)
    const open = await listOpenDrafts(fx.db, fx.seed.registerId)
    expect(open).toHaveLength(1)
    expect(open[0]!.billId).toBe(kept.billId)
  })
})

describe('a held bill keeps what it quoted', () => {
  /* The bug: saveDraft re-ran the whole resolution chain, so a bill parked past a
     price list's valid_to silently re-priced itself under the customer. */
  it('does not re-price a line when the caller passes the rate back', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)

    const list = await fx.db.get<{ id: string }>(`SELECT id FROM price_lists WHERE is_default = 1`)
    const priceId = newId()
    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, valid_to, created_at, updated_at)
       VALUES (?, ?, ?, 'piece', 0, ?, '2099-12-31', ?, ?)`,
      [priceId, p, list!.id, rupees(80), now, now],
    )

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(2) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    expect(draft.grandTotal).toBe(rupees(160))

    const held = (await loadDraft(fx.db, draft.billId))!
    expect(held.lines[0]!.rate).toBe(rupees(80))
    expect(held.lines[0]!.priceSource).toBe('default_list')
    expect(held.lines[0]!.priceSourceId).toBe(priceId)

    // The offer expires while the bill is parked.
    await fx.db.execute(`UPDATE item_prices SET valid_to = '2020-01-01' WHERE id = ?`, [priceId])

    const saved = await saveDraft(fx.db, {
      billId: draft.billId,
      registerId: fx.seed.registerId,
      lines: held.lines.map((l) => ({
        productId: l.productId,
        saleUnit: l.saleUnit,
        qty: l.qty,
        resolved: { rate: l.rate, source: l.priceSource, sourceId: l.priceSourceId },
      })),
      actorId: fx.adminId,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    expect(saved.grandTotal).toBe(rupees(160))
    const after = (await loadDraft(fx.db, draft.billId))!
    expect(after.lines[0]!.rate).toBe(rupees(80))
    expect(after.lines[0]!.priceSourceId).toBe(priceId)
  })

  it('re-prices a line the caller does not pass a rate for', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const draft = await start(p, 2)

    await fx.db.execute(`UPDATE products SET base_rate = ? WHERE id = ?`, [rupees(150), p])

    const saved = await saveDraft(fx.db, {
      billId: draft.billId,
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(2) }],
      actorId: fx.adminId,
    })
    if (!saved.ok) throw new Error('save failed')
    expect(saved.grandTotal).toBe(rupees(300))
  })

  it('keeps a typed rate marked as the cashier’s, not as a resolved one', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1), rateOverride: rupees(72) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')

    const held = (await loadDraft(fx.db, draft.billId))!
    expect(held.lines[0]!.rate).toBe(rupees(72))
    expect(held.lines[0]!.priceSource).toBe('manual_override')
    expect(held.lines[0]!.priceSourceId).toBeNull()
  })
})

describe('two tabs at one counter', () => {
  /* What the tab bar rests on: each tab is its own draft, and working in one
     must not disturb another. */
  it('keeps two drafts independent when one is edited', async () => {
    const pen = await makeProduct(fx.db, { name: 'Ball Pen', baseRate: rupees(10), taxRateBp: 0 })
    const book = await makeProduct(fx.db, { name: 'Note Book', baseRate: rupees(40), taxRateBp: 0 })
    await stockUp(fx.db, pen, 50)
    await stockUp(fx.db, book, 50)

    const first = await start(pen, 2)
    const second = await start(book, 1)

    const saved = await saveDraft(fx.db, {
      billId: second.billId,
      registerId: fx.seed.registerId,
      lines: [{ productId: book, qty: fromUnits(5) }],
      actorId: fx.adminId,
    })
    if (!saved.ok) throw new Error('save failed')

    const open = await listOpenDrafts(fx.db, fx.seed.registerId)
    expect(open).toHaveLength(2)
    expect(open.find((d) => d.billId === first.billId)!.grandTotal).toBe(rupees(20))
    expect(open.find((d) => d.billId === second.billId)!.grandTotal).toBe(rupees(200))
  })

  it('leaves the other tab alone when one is cancelled', async () => {
    const pen = await makeProduct(fx.db, { name: 'Ball Pen', baseRate: rupees(10), taxRateBp: 0 })
    await stockUp(fx.db, pen, 50)

    const first = await start(pen, 2)
    const second = await start(pen, 3)

    await discardDraft(fx.db, { billId: second.billId, actorId: fx.adminId })

    const open = await listOpenDrafts(fx.db, fx.seed.registerId)
    expect(open).toHaveLength(1)
    expect(open[0]!.billId).toBe(first.billId)
    expect((await loadDraft(fx.db, first.billId))!.lines).toHaveLength(1)
  })

  it('numbers only the bill that is paid, leaving the other a draft', async () => {
    const pen = await makeProduct(fx.db, { name: 'Ball Pen', baseRate: rupees(10), taxRateBp: 0 })
    await stockUp(fx.db, pen, 50)

    const first = await start(pen, 2)
    const second = await start(pen, 3)

    const done = await submitBill(fx.db, {
      billId: second.billId,
      payments: [{ method: 'cash', amount: second.grandTotal }],
      actorId: fx.adminId,
    })
    if (!done.ok) throw new Error('submit failed')

    expect(done.docNo).toMatch(/00001$/)
    const open = await listOpenDrafts(fx.db, fx.seed.registerId)
    expect(open).toHaveLength(1)
    expect(open[0]!.billId).toBe(first.billId)

    // And the held one takes the next number, with no gap.
    const after = await submitBill(fx.db, {
      billId: first.billId,
      payments: [{ method: 'cash', amount: first.grandTotal }],
      actorId: fx.adminId,
    })
    if (!after.ok) throw new Error('submit failed')
    expect(after.docNo).toMatch(/00002$/)
  })
})
