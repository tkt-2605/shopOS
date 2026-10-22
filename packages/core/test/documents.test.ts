import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createDocument, submitDocument, cancelDocument, listDocuments, loadDocument,
} from '../src/services/documents.js'
import { quotationToSalesOrder, receivePurchaseOrder, closePurchaseOrderShort } from '../src/services/convert.js'
import { reconcileFulfilledQty } from '../src/services/documents/reconcile.js'
import { currentStock } from '../src/services/stock.js'
import { setItemPrice } from '../src/services/pricing.js'
import { defaultPriceListId } from '../src/repos/pricing.js'
import { rupees } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Documents that are promises rather than records.
 *
 * The theme is that none of these moves anything until it is converted, and
 * that converting one twice must not charge the customer twice.
 */

let fx: Fixture
let productId: string
let customerId: string
let supplierId: string

beforeEach(async () => {
  fx = await freshDb()
  productId = await makeProduct(fx.db, { baseRate: 10000, taxRateBp: 0 })
  customerId = await makeCustomer(fx.db, 'Sri Vidya School')

  supplierId = newId()
  const now = new Date().toISOString()
  await fx.db.execute(
    `INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [supplierId, 'Paper Mills', now, now],
  )
})

afterEach(async () => { await fx.db.close() })

async function quote(units = 10, opts: { validUntil?: string } = {}) {
  const made = await createDocument(fx.db, {
    kind: 'quotation',
    registerId: fx.seed.registerId,
    customerId,
    lines: [{ productId, qty: fromUnits(units) }],
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
    actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(`the quotation was refused: ${made.code}`)
  await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
  return made
}

async function purchaseOrder(units = 20, unitCost = rupees(60)) {
  const made = await createDocument(fx.db, {
    kind: 'purchase_order',
    registerId: fx.seed.registerId,
    supplierId,
    lines: [{ productId, qty: fromUnits(units), rateOverride: unitCost }],
    actorId: fx.adminId,
  })
  if (!made.ok) throw new Error(`the purchase order was refused: ${made.code}`)
  await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
  return made
}

describe('raising a document', () => {
  it('numbers a quotation in its own series, not the bill series', async () => {
    const made = await quote()
    expect(made.docNo).toContain('QMR/')
    expect(made.docNo).not.toContain('BMR/')
  })

  it('gives each kind a series of its own', async () => {
    const q = await quote()
    const po = await purchaseOrder()
    expect(q.docNo).toContain('QMR/')
    expect(po.docNo).toContain('PMR/')
  })

  it('prices from the same rules the counter uses', async () => {
    const listId = await defaultPriceListId(fx.db)
    await setItemPrice(fx.db, { actorId: fx.adminId }, {
      priceListId: listId!, productId, saleUnit: 'piece', rate: rupees(85),
    })

    const made = await quote(4)
    const doc = await loadDocument(fx.db, made.documentId)
    expect(doc!.items[0]!.rate).toBe(rupees(85))
  })

  it('refuses a quotation addressed to nobody', async () => {
    const made = await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    expect(made).toEqual({ ok: false, code: 'PARTY_REQUIRED' })
  })

  it('refuses a purchase order placed with nobody', async () => {
    const made = await createDocument(fx.db, {
      kind: 'purchase_order', registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    expect(made).toEqual({ ok: false, code: 'PARTY_REQUIRED' })
  })

  it('refuses a document with no lines on it', async () => {
    const made = await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId,
      lines: [], actorId: fx.adminId,
    })
    expect(made).toEqual({ ok: false, code: 'NO_LINES' })
  })

  it('records who raised it', async () => {
    const made = await quote()
    const rows = await fx.db.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE entity = 'document' AND entity_id = ?`,
      [made.documentId],
    )
    expect(rows.map((r) => r.action)).toEqual(['create', 'submit'])
    expect(rows[0]!.actor_id).toBe(fx.adminId)
  })
})

describe('what a submitted document does not do', () => {
  it('moves no stock, because a promise is not a delivery', async () => {
    const before = await currentStock(fx.db, productId)
    await quote(50)
    expect(await currentStock(fx.db, productId)).toBe(before)
  })

  it('writes no stock ledger row at all', async () => {
    await quote(50)
    const rows = await fx.db.query(`SELECT id FROM stock_ledger WHERE product_id = ?`, [productId])
    expect(rows).toHaveLength(0)
  })

  it('can be raised for more than the shop has, because ordering is the point', async () => {
    const made = await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId,
      lines: [{ productId, qty: fromUnits(9999) }], actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)
  })
})

describe('cancelling', () => {
  it('takes the document out of the list', async () => {
    const made = await quote()
    await cancelDocument(fx.db, {
      documentId: made.documentId, reason: 'Customer changed their mind', actorId: fx.adminId,
    })
    expect((await loadDocument(fx.db, made.documentId))!.docstatus).toBe(2)
  })

  it('refuses once the whole of it has been acted on, and says so in those words', async () => {
    // The order it became exists; saying this one never happened would leave
    // that document pointing at a promise the shop denies making.
    const made = await quote()
    await quotationToSalesOrder(fx.db, { quotationId: made.documentId, actorId: fx.adminId })

    const gone = await cancelDocument(fx.db, {
      documentId: made.documentId, reason: 'Too late', actorId: fx.adminId,
    })
    expect(gone.ok).toBe(false)
    /* Not `PARTLY_FULFILLED`, which is what this used to answer and what the
       screen used to repeat: "part of this has already been delivered". Every
       line of it has. A shopkeeper told that part of something has gone goes
       looking for the part that has not. */
    if (!gone.ok) expect(gone).toEqual({ ok: false, code: 'FULLY_FULFILLED', lines: 1 })
  })

  it('refuses when only some of it has been acted on, and says that instead', async () => {
    /* Reached by billing an order for fewer than it promised, which a counter
       does when half the delivery is short. Written straight into the line here
       rather than run through a bill: what is being tested is how
       `cancelDocument` classifies the state, not the path that arrives at it —
       and a bill would bring its own stock, tax and payment along for the
       ride. */
    const made = await quote(10)
    await fx.db.execute(
      `UPDATE document_items SET fulfilled_qty = ? WHERE document_id = ?`,
      [fromUnits(4), made.documentId],
    )

    const gone = await cancelDocument(fx.db, {
      documentId: made.documentId, reason: 'Too late', actorId: fx.adminId,
    })
    expect(gone).toEqual({ ok: false, code: 'PARTLY_FULFILLED', fulfilled: 1, lines: 1 })
  })

  it('refuses to cancel the same document twice', async () => {
    const made = await quote()
    await cancelDocument(fx.db, { documentId: made.documentId, reason: 'One', actorId: fx.adminId })
    const again = await cancelDocument(fx.db, {
      documentId: made.documentId, reason: 'Two', actorId: fx.adminId,
    })
    expect(again).toEqual({ ok: false, code: 'ALREADY_CANCELLED' })
  })
})

describe('a quotation becoming an order', () => {
  it('keeps the rate that was quoted rather than today rate', async () => {
    const listId = await defaultPriceListId(fx.db)
    await setItemPrice(fx.db, { actorId: fx.adminId }, {
      priceListId: listId!, productId, saleUnit: 'piece', rate: rupees(85),
    })
    const made = await quote(4)

    // The shop puts its prices up between quoting and the customer accepting.
    await setItemPrice(fx.db, { actorId: fx.adminId }, {
      priceListId: listId!, productId, saleUnit: 'piece', rate: rupees(120),
    })

    const order = await quotationToSalesOrder(fx.db, {
      quotationId: made.documentId, actorId: fx.adminId,
    })
    expect(order.ok).toBe(true)
    if (!order.ok) return

    // A quotation is a promise, and honouring it is the entire point.
    expect((await loadDocument(fx.db, order.documentId))!.items[0]!.rate).toBe(rupees(85))
  })

  it('records what it came from', async () => {
    const made = await quote()
    const order = await quotationToSalesOrder(fx.db, {
      quotationId: made.documentId, actorId: fx.adminId,
    })
    if (!order.ok) throw new Error('the conversion was refused')

    expect((await loadDocument(fx.db, order.documentId))!.convertedFrom).toBe(made.documentId)
  })

  it('marks the quotation off, so it cannot be converted twice', async () => {
    const made = await quote()
    await quotationToSalesOrder(fx.db, { quotationId: made.documentId, actorId: fx.adminId })

    const again = await quotationToSalesOrder(fx.db, {
      quotationId: made.documentId, actorId: fx.adminId,
    })
    expect(again).toEqual({ ok: false, code: 'NOTHING_LEFT' })
  })

  it('refuses a quotation nobody has submitted yet', async () => {
    const made = await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId,
      lines: [{ productId, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!made.ok) throw new Error('the quotation was refused')

    expect(await quotationToSalesOrder(fx.db, {
      quotationId: made.documentId, actorId: fx.adminId,
    })).toEqual({ ok: false, code: 'NOT_SUBMITTED' })
  })

  it('refuses a quotation whose date has passed', async () => {
    // The customer is holding paper with a number on it; quietly charging a
    // different one is the argument this document exists to prevent.
    const made = await quote(5, { validUntil: '2020-01-01' })
    expect(await quotationToSalesOrder(fx.db, {
      quotationId: made.documentId, actorId: fx.adminId,
    })).toEqual({ ok: false, code: 'EXPIRED' })
  })

  it('refuses to convert a purchase order down the sales route', async () => {
    const po = await purchaseOrder()
    expect(await quotationToSalesOrder(fx.db, {
      quotationId: po.documentId, actorId: fx.adminId,
    })).toEqual({ ok: false, code: 'WRONG_KIND' })
  })
})

describe('goods arriving against a purchase order', () => {
  it('puts the stock on the shelf', async () => {
    const before = await currentStock(fx.db, productId)
    const po = await purchaseOrder(20)

    const received = await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.documentId, actorId: fx.adminId,
    })
    expect(received.ok).toBe(true)

    expect(toUnits(await currentStock(fx.db, productId))).toBe(toUnits(before) + 20)
  })

  it('receives it at the cost that was ordered, not at a list price', async () => {
    // A delivery valued at anything else quietly rewrites every margin report
    // that touches the item.
    const po = await purchaseOrder(10, rupees(60))
    await receivePurchaseOrder(fx.db, { purchaseOrderId: po.documentId, actorId: fx.adminId })

    const row = await fx.db.get<{ unit_cost: number }>(
      `SELECT unit_cost FROM stock_ledger WHERE product_id = ? ORDER BY rowid DESC LIMIT 1`,
      [productId],
    )
    expect(row!.unit_cost).toBe(rupees(60))
  })

  it('refuses to receive the same order twice', async () => {
    const po = await purchaseOrder(10)
    await receivePurchaseOrder(fx.db, { purchaseOrderId: po.documentId, actorId: fx.adminId })

    expect(await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.documentId, actorId: fx.adminId,
    })).toEqual({ ok: false, code: 'NOTHING_LEFT' })
  })

  it('does not put the goods on the shelf twice either', async () => {
    const before = await currentStock(fx.db, productId)
    const po = await purchaseOrder(10)
    await receivePurchaseOrder(fx.db, { purchaseOrderId: po.documentId, actorId: fx.adminId })
    await receivePurchaseOrder(fx.db, { purchaseOrderId: po.documentId, actorId: fx.adminId })

    expect(toUnits(await currentStock(fx.db, productId))).toBe(toUnits(before) + 10)
  })
})

describe('a delivery short of the order', () => {
  /** A second item, so a delivery can bring one line and not the other. */
  async function twoLineOrder() {
    const other = await makeProduct(fx.db, { baseRate: 5000, taxRateBp: 0 })
    const made = await createDocument(fx.db, {
      kind: 'purchase_order',
      registerId: fx.seed.registerId,
      supplierId,
      lines: [
        { productId, qty: fromUnits(10), rateOverride: rupees(60) },
        { productId: other, qty: fromUnits(5), rateOverride: rupees(30) },
      ],
      actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(`the purchase order was refused: ${made.code}`)
    await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
    const doc = (await loadDocument(fx.db, made.documentId))!
    return { id: made.documentId, other, first: doc.items[0]!.id, second: doc.items[1]!.id }
  }

  it('puts on the shelf only what came, and leaves the rest open', async () => {
    const po = await twoLineOrder()
    const before = await currentStock(fx.db, productId)

    const received = await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId,
      lines: [{ itemId: po.first, qty: fromUnits(8) }, { itemId: po.second, qty: fromUnits(0) }],
    })
    expect(received.ok).toBe(true)

    expect(toUnits(await currentStock(fx.db, productId))).toBe(toUnits(before) + 8)
    expect(toUnits(await currentStock(fx.db, po.other))).toBe(0)
    const doc = (await loadDocument(fx.db, po.id))!
    expect(doc.items.map((i) => toUnits(i.remainingQty))).toEqual([2, 5])
    expect(doc.progress).toBe('part')
  })

  it('takes the rest in a second delivery and is then finished', async () => {
    const po = await twoLineOrder()
    await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId, lines: [{ itemId: po.first, qty: fromUnits(8) }],
    })
    expect((await receivePurchaseOrder(fx.db, { purchaseOrderId: po.id, actorId: fx.adminId })).ok).toBe(true)

    const doc = (await loadDocument(fx.db, po.id))!
    expect(doc.items.map((i) => toUnits(i.remainingQty))).toEqual([0, 0])
    expect(doc.progress).toBe('done')
    expect(toUnits(await currentStock(fx.db, po.other))).toBe(5)
  })

  it('refuses more than a line has open, and writes nothing', async () => {
    const po = await twoLineOrder()
    const before = await currentStock(fx.db, productId)

    expect(await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId,
      lines: [{ itemId: po.first, qty: fromUnits(11) }],
    })).toEqual({ ok: false, code: 'OVER_RECEIVED', itemId: po.first, remaining: fromUnits(10) })

    expect(await currentStock(fx.db, productId)).toBe(before)
    expect(toUnits((await loadDocument(fx.db, po.id))!.items[0]!.remainingQty)).toBe(10)
  })

  it('refuses a delivery of nothing, two batches over the line between them, and a line from another order', async () => {
    const po = await twoLineOrder()
    expect(await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId, lines: [{ itemId: po.first, qty: fromUnits(0) }],
    })).toEqual({ ok: false, code: 'NOTHING_ENTERED' })
    expect(await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId,
      lines: [{ itemId: po.first, qty: fromUnits(6) }, { itemId: po.first, qty: fromUnits(5) }],
    })).toEqual({ ok: false, code: 'OVER_RECEIVED', itemId: po.first, remaining: fromUnits(10) })
    expect(await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId, lines: [{ itemId: 'not-a-line', qty: fromUnits(1) }],
    })).toEqual({ ok: false, code: 'UNKNOWN_LINE', itemId: 'not-a-line' })
  })

  it('takes the cost on the supplier bill when it differs from the order', async () => {
    const po = await twoLineOrder()
    await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId,
      lines: [{ itemId: po.first, qty: fromUnits(10), unitCost: rupees(62) }],
      supplierInvoiceNo: 'PM/4471',
    })
    const row = await fx.db.get<{ unit_cost: number }>(
      `SELECT unit_cost FROM stock_ledger WHERE product_id = ? ORDER BY rowid DESC LIMIT 1`, [productId],
    )
    expect(row!.unit_cost).toBe(rupees(62))
    const entry = await fx.db.get<{ supplier_invoice_no: string }>(
      `SELECT supplier_invoice_no FROM stock_entries ORDER BY rowid DESC LIMIT 1`,
    )
    expect(entry!.supplier_invoice_no).toBe('PM/4471')
  })

  it('takes one order line in as two batches and marks it off by both', async () => {
    const po = await twoLineOrder()
    const received = await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId,
      lines: [
        { itemId: po.first, qty: fromUnits(6), batchNo: 'A1', expiryDate: '2027-03-31' },
        { itemId: po.first, qty: fromUnits(4), batchNo: 'A2', expiryDate: '2027-06-30', mrp: rupees(120) },
      ],
    })
    expect(received.ok).toBe(true)
    const doc = (await loadDocument(fx.db, po.id))!
    expect(toUnits(doc.items[0]!.remainingQty)).toBe(0)
    const batches = await fx.db.query<{ batch_no: string; expiry_date: string }>(
      `SELECT batch_no, expiry_date FROM batches WHERE product_id = ? ORDER BY batch_no`, [productId],
    )
    expect(batches.map((b) => [b.batch_no, b.expiry_date])).toEqual([['A1', '2027-03-31'], ['A2', '2027-06-30']])
    expect(await reconcileFulfilledQty(fx.db)).toEqual([])
  })

  it('takes goods the order never asked for on the same bill, marking nothing off for them', async () => {
    const po = await twoLineOrder()
    const extra = await makeProduct(fx.db, { baseRate: 2000, taxRateBp: 0 })
    const received = await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId,
      lines: [{ itemId: po.first, qty: fromUnits(10) }, { productId: extra, qty: fromUnits(3), unitCost: rupees(12) }],
    })
    expect(received.ok).toBe(true)
    expect(toUnits(await currentStock(fx.db, extra))).toBe(3)
    const doc = (await loadDocument(fx.db, po.id))!
    expect(doc.items.map((i) => toUnits(i.remainingQty))).toEqual([0, 5])
  })

  it('will not take only unordered goods as a receipt of the order', async () => {
    const po = await twoLineOrder()
    const extra = await makeProduct(fx.db, { baseRate: 2000, taxRateBp: 0 })
    expect(await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId, lines: [{ productId: extra, qty: fromUnits(3) }],
    })).toEqual({ ok: false, code: 'NOTHING_ENTERED' })
  })

  it('carries the order line GST onto the stock entry when none is given', async () => {
    const taxed = await makeProduct(fx.db, { baseRate: 10000, taxRateBp: 1200 })
    const made = await createDocument(fx.db, {
      kind: 'purchase_order', registerId: fx.seed.registerId, supplierId,
      lines: [{ productId: taxed, qty: fromUnits(2), rateOverride: rupees(50) }], actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(made.code)
    await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
    expect((await receivePurchaseOrder(fx.db, { purchaseOrderId: made.documentId, actorId: fx.adminId })).ok).toBe(true)
    const row = await fx.db.get<{ tax_rate_bp: number }>(
      `SELECT tax_rate_bp FROM stock_entry_items WHERE product_id = ?`, [taxed],
    )
    expect(row!.tax_rate_bp).toBe(1200)
  })

  it('passes a refusal of the delivery itself through, and writes nothing', async () => {
    const po = await twoLineOrder()
    const result = await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId,
      lines: [{ itemId: po.first, qty: fromUnits(5), batchNo: 'B1', expiryDate: 'soon' }],
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.code).toBe('BAD_EXPIRY')
    expect(toUnits((await loadDocument(fx.db, po.id))!.items[0]!.remainingQty)).toBe(10)
  })

  it('closes what will not come, with no stock and a reason on record', async () => {
    const po = await twoLineOrder()
    await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId, lines: [{ itemId: po.first, qty: fromUnits(8) }],
    })
    const before = await currentStock(fx.db, productId)

    expect(await closePurchaseOrderShort(fx.db, {
      purchaseOrderId: po.id, reason: 'Supplier out of stock', actorId: fx.adminId,
    })).toEqual({ ok: true, closedLines: 2 })

    expect(await currentStock(fx.db, productId)).toBe(before)
    const doc = (await loadDocument(fx.db, po.id))!
    expect(doc.progress).toBe('done')
    expect(doc.items.map((i) => toUnits(i.closedQty))).toEqual([2, 5])
    expect(doc.items.map((i) => toUnits(i.remainingQty))).toEqual([0, 0])
    expect(await receivePurchaseOrder(fx.db, { purchaseOrderId: po.id, actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'NOTHING_LEFT' })
    // The record a merge rebuilds `fulfilled_qty` from agrees with it.
    expect(await reconcileFulfilledQty(fx.db)).toEqual([])
  })

  it('will not close short an order nothing came against: that is a cancellation', async () => {
    const po = await twoLineOrder()
    expect(await closePurchaseOrderShort(fx.db, {
      purchaseOrderId: po.id, reason: 'Never came', actorId: fx.adminId,
    })).toEqual({ ok: false, code: 'NOTHING_RECEIVED' })
  })

  it('wants a reason', async () => {
    const po = await twoLineOrder()
    await receivePurchaseOrder(fx.db, {
      purchaseOrderId: po.id, actorId: fx.adminId, lines: [{ itemId: po.first, qty: fromUnits(8) }],
    })
    expect(await closePurchaseOrderShort(fx.db, { purchaseOrderId: po.id, reason: '  ', actorId: fx.adminId }))
      .toEqual({ ok: false, code: 'REASON_REQUIRED' })
  })
})

describe('finding documents again', () => {
  it('lists only the kind asked for', async () => {
    await quote()
    await purchaseOrder()

    expect(await listDocuments(fx.db, { kind: 'quotation' })).toHaveLength(1)
    expect(await listDocuments(fx.db, { kind: 'purchase_order' })).toHaveLength(1)
  })

  it('keeps a document nobody submitted out of the list', async () => {
    await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId,
      lines: [{ productId, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    expect(await listDocuments(fx.db, {})).toHaveLength(0)
  })

  it('says whether an order is open, part done, or finished', async () => {
    const made = await quote()
    expect((await listDocuments(fx.db, { kind: 'quotation' }))[0]!.progress).toBe('open')

    await quotationToSalesOrder(fx.db, { quotationId: made.documentId, actorId: fx.adminId })
    expect((await listDocuments(fx.db, { kind: 'quotation' }))[0]!.progress).toBe('done')
  })

  it('finds one by the party it was addressed to', async () => {
    await quote()
    expect(await listDocuments(fx.db, { search: 'Vidya' })).toHaveLength(1)
    expect(await listDocuments(fx.db, { search: 'nobody' })).toHaveLength(0)
  })

  it('separates what is still open from what is finished', async () => {
    /* The reason this filter exists. "Issued" is what every live document is,
       so a list of them is a list a shopkeeper cannot work from: a quotation
       won and billed last month sits in it for ever, next to the ones still
       waiting for an answer. */
    const open = await quote(5)
    const won = await quote(7)
    await quotationToSalesOrder(fx.db, { quotationId: won.documentId, actorId: fx.adminId })

    const still = await listDocuments(fx.db, { kind: 'quotation', status: 'open' })
    expect(still.map((d) => d.id)).toEqual([open.documentId])

    const done = await listDocuments(fx.db, { kind: 'quotation', status: 'completed' })
    expect(done.map((d) => d.id)).toEqual([won.documentId])

    // And both are still issued, because completed is a view and not a fourth
    // docstatus.
    expect(await listDocuments(fx.db, { kind: 'quotation', status: 'issued' })).toHaveLength(2)
  })

  it('counts a part-billed order as open, because something is still owed on it', async () => {
    const made = await quote(10)
    await fx.db.execute(
      `UPDATE document_items SET fulfilled_qty = ? WHERE document_id = ?`,
      [fromUnits(4), made.documentId],
    )

    expect(await listDocuments(fx.db, { status: 'open' })).toHaveLength(1)
    expect(await listDocuments(fx.db, { status: 'completed' })).toHaveLength(0)
  })

  it('keeps a cancelled document out of both, however far along it got', async () => {
    const made = await quote()
    await cancelDocument(fx.db, { documentId: made.documentId, reason: 'No', actorId: fx.adminId })

    expect(await listDocuments(fx.db, { status: 'open' })).toHaveLength(0)
    expect(await listDocuments(fx.db, { status: 'completed' })).toHaveLength(0)
    expect(await listDocuments(fx.db, { status: 'cancelled' })).toHaveLength(1)
  })

  it('finds a draft when the draft is what is being looked for', async () => {
    // A quotation started while the customer is on the phone and finished
    // after somebody has checked a price has to be findable in between.
    await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId,
      lines: [{ productId, qty: fromUnits(1) }], actorId: fx.adminId,
    })

    expect(await listDocuments(fx.db, { status: 'draft' })).toHaveLength(1)
    expect(await listDocuments(fx.db, { status: 'issued' })).toHaveLength(0)
  })

  it('lists a cancelled document only when cancelled ones are asked for', async () => {
    const made = await quote()
    await cancelDocument(fx.db, {
      documentId: made.documentId, reason: 'The school went elsewhere', actorId: fx.adminId,
    })

    expect(await listDocuments(fx.db, {})).toHaveLength(0)
    expect(await listDocuments(fx.db, { status: 'cancelled' })).toHaveLength(1)
  })

  it('shows every state at once when asked for all of them', async () => {
    await quote()
    await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId,
      lines: [{ productId, qty: fromUnits(1) }], actorId: fx.adminId,
    })

    expect(await listDocuments(fx.db, { status: 'all' })).toHaveLength(2)
  })

  it('shows what is left on each line', async () => {
    const po = await purchaseOrder(20)
    const doc = await loadDocument(fx.db, po.documentId)
    expect(toUnits(doc!.items[0]!.remainingQty)).toBe(20)

    await receivePurchaseOrder(fx.db, { purchaseOrderId: po.documentId, actorId: fx.adminId })
    const after = await loadDocument(fx.db, po.documentId)
    expect(toUnits(after!.items[0]!.remainingQty)).toBe(0)
  })
})
