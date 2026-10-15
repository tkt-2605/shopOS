import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDocument, submitDocument, loadDocument } from '../src/services/documents.js'
import { documentToCart } from '../src/services/convert.js'
import { createBill, submitBill, cancelBill, amendBill } from '../src/services/billing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, toUnits, type Qty } from '../src/quantity.js'
import { postMovement } from '../src/services/stock.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Billing an order.
 *
 * The theme is **when** an order is marked off. Loading it onto the counter
 * promises nothing — a cart can be abandoned, emptied, or left open overnight —
 * and an order the shop believes it has already sent out is a worse record than
 * one that says nothing at all. So the mark comes with the payment, and goes
 * back if the payment is cancelled.
 */

let fx: Fixture
let productId: string
let customerId: string

beforeEach(async () => {
  fx = await freshDb()
  productId = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  customerId = await makeCustomer(fx.db, 'Sri Vidya School')
  await stockUp(fx.db, productId, 500)
})

afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost: rupees(50),
      voucherType: 'opening',
      voucherId: newId(),
      postingDate: '2026-01-01',
    })
  })
}

async function order(units = 10, opts: { kind?: 'quotation' | 'sales_order'; validUntil?: string } = {}) {
  const made = await createDocument(fx.db, {
    kind: opts.kind ?? 'sales_order',
    registerId: fx.seed.registerId,
    customerId,
    lines: [{ productId, qty: fromUnits(units) }],
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
    actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(`the order was refused: ${made.code}`)
  await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
  return made.documentId
}

/** What the counter does with what `documentToCart` hands it. */
async function cart(documentId: string, units?: number) {
  const loaded = await documentToCart(fx.db, { documentId })
  if (!loaded.ok) throw new Error(`the order would not load: ${loaded.code}`)

  return createBill(fx.db, {
    registerId: fx.seed.registerId,
    customerId: loaded.customerId,
    convertedFrom: loaded.documentId,
    lines: loaded.lines.map((l) => ({
      productId: l.productId,
      saleUnit: l.saleUnit,
      qty: units === undefined ? l.qty : fromUnits(units),
      resolved: { rate: l.rate, source: 'order_rate' as const, sourceId: loaded.documentId },
    })),
    actorId: fx.adminId,
  })
}

async function pay(draft: { billId: string; grandTotal: Money }) {
  return submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
}

async function fulfilled(documentId: string): Promise<number> {
  const doc = await loadDocument(fx.db, documentId)
  return toUnits(doc!.items[0]!.fulfilledQty as Qty)
}

describe('putting an order on the counter', () => {
  it('marks nothing off while the bill is still a draft', async () => {
    const id = await order(10)
    const draft = await cart(id)
    expect(draft.ok).toBe(true)

    expect(await fulfilled(id)).toBe(0)
    const doc = await loadDocument(fx.db, id)
    expect(doc!.progress).toBe('open')
  })

  it('marks the order off when the money is taken', async () => {
    const id = await order(10)
    const draft = await cart(id)
    if (!draft.ok) return

    const paid = await pay(draft)
    expect(paid.ok).toBe(true)
    expect(await fulfilled(id)).toBe(10)
    expect((await loadDocument(fx.db, id))!.progress).toBe('done')
  })

  it('keeps the rate the order promised rather than the rate today', async () => {
    const id = await order(10)
    // The shop puts its prices up between the order and the delivery.
    await fx.db.execute(`UPDATE products SET base_rate = ? WHERE id = ?`, [rupees(140), productId])

    const draft = await cart(id)
    if (!draft.ok) return
    expect(draft.grandTotal).toBe(rupees(1000))

    const line = await fx.db.get<{ rate: number; price_source: string; price_source_id: string }>(
      `SELECT rate, price_source, price_source_id FROM bill_items WHERE bill_id = ?`, [draft.billId],
    )
    expect(line?.rate).toBe(rupees(100))
    // And says where the price came from, so nobody has to guess later.
    expect(line?.price_source).toBe('order_rate')
    expect(line?.price_source_id).toBe(id)
  })

  it('hands over only what is still outstanding', async () => {
    const id = await order(10)
    const first = await cart(id, 4)
    if (!first.ok) return
    await pay(first)

    const left = await documentToCart(fx.db, { documentId: id })
    expect(left.ok).toBe(true)
    if (!left.ok) return
    expect(toUnits(left.lines[0]!.qty)).toBe(6)
  })

  it('finishes the order when the rest is billed', async () => {
    const id = await order(10)
    const first = await cart(id, 4)
    if (!first.ok) return
    await pay(first)

    const rest = await cart(id)
    if (!rest.ok) return
    await pay(rest)

    expect(await fulfilled(id)).toBe(10)
    expect((await loadDocument(fx.db, id))!.progress).toBe('done')
  })

  it('refuses an order with nothing left on it', async () => {
    const id = await order(10)
    const draft = await cart(id)
    if (!draft.ok) return
    await pay(draft)

    const again = await documentToCart(fx.db, { documentId: id })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe('NOTHING_LEFT')
  })

  it('refuses a quotation that is past its date', async () => {
    const id = await order(10, { kind: 'quotation', validUntil: '2020-01-01' })
    const loaded = await documentToCart(fx.db, { documentId: id })
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.code).toBe('EXPIRED')
  })

  it('refuses to bill a purchase order, which is money the shop owes', async () => {
    const supplierId = 'sup-1'
    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [supplierId, 'Paper Mills', now, now],
    )
    const made = await createDocument(fx.db, {
      kind: 'purchase_order',
      registerId: fx.seed.registerId,
      supplierId,
      lines: [{ productId, qty: fromUnits(5), rateOverride: rupees(60) }],
      actorId: fx.adminId,
    })
    if (!made.ok) return
    await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })

    const loaded = await documentToCart(fx.db, { documentId: made.documentId })
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.code).toBe('WRONG_KIND')
  })
})

describe('cancelling a bill that came from an order', () => {
  it('gives back exactly what that bill had taken', async () => {
    const id = await order(10)

    const first = await cart(id, 6)
    if (!first.ok) return
    await pay(first)

    const second = await cart(id)
    if (!second.ok) return
    await pay(second)
    expect(await fulfilled(id)).toBe(10)

    /* The first bill goes, the second stands. A reversal that recomputed the
       share now — with only four left on the line — would hand back four, and
       the order would be two short for ever. */
    const undone = await cancelBill(fx.db, { billId: first.billId, reason: 'wrong customer', actorId: fx.adminId })
    expect(undone.ok).toBe(true)
    expect(await fulfilled(id)).toBe(4)
  })

  it('counts nothing for a bill that was cancelled, and keeps its record of what it took', async () => {
    /* The record stays, as a cancelled bill's other lines do: it is a line of a
       submitted bill, and deleting it made every other till refuse the
       cancellation (`apartFromTheMain.test.ts`, 24). What it took is no
       longer counted against the order. */
    const id = await order(10)
    const draft = await cart(id)
    if (!draft.ok) return
    await pay(draft)
    await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })

    const kept = await fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bill_fulfilments WHERE bill_id = ?`, [draft.billId],
    )
    expect(kept?.n).toBeGreaterThan(0)
    expect(await fulfilled(id)).toBe(0)
    expect((await loadDocument(fx.db, id))!.progress).toBe('open')
  })
})

describe('amending a bill that came from an order', () => {
  it('carries the order onto the amendment, so paying it marks the order off again', async () => {
    const id = await order(10)
    const draft = await cart(id)
    if (!draft.ok) return
    await pay(draft)
    await cancelBill(fx.db, { billId: draft.billId, reason: 'wrong quantity', actorId: fx.adminId })
    expect(await fulfilled(id)).toBe(0)

    const amended = await amendBill(fx.db, { billId: draft.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
    if (!amended.ok) return
    // Still nothing: an amendment is a draft like any other.
    expect(await fulfilled(id)).toBe(0)

    await pay(amended)
    expect(await fulfilled(id)).toBe(10)
  })
})

describe('a cart that stopped being the order', () => {
  it('marks nothing off when nothing on the bill answers the order', async () => {
    const id = await order(10)
    const somethingElse = await makeProduct(fx.db, { baseRate: rupees(50), taxRateBp: 0 })
    await stockUp(fx.db, somethingElse, 20)

    /* The cashier emptied the cart and rang up different items against the same
       draft. The bill is real and stands; the order is simply untouched. */
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId,
      convertedFrom: id,
      lines: [{ productId: somethingElse, qty: fromUnits(2) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) return
    const paid = await pay(draft)

    expect(paid.ok).toBe(true)
    expect(await fulfilled(id)).toBe(0)
  })
})
