import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createDocument, submitDocument, cancelDocument, listDocuments, loadDocument,
} from '../src/services/documents.js'
import { quotationToSalesOrder, receivePurchaseOrder } from '../src/services/convert.js'
import { currentStock, postMovement } from '../src/services/stock.js'
import { setItemPrice } from '../src/services/pricing.js'
import { defaultPriceListId } from '../src/repos/pricing.js'
import { rupees, type Money } from '../src/money.js'
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

  it('refuses once part of it has been acted on', async () => {
    // The order it became exists; saying this one never happened would leave
    // that document pointing at a promise the shop denies making.
    const made = await quote()
    await quotationToSalesOrder(fx.db, { quotationId: made.documentId, actorId: fx.adminId })

    const gone = await cancelDocument(fx.db, {
      documentId: made.documentId, reason: 'Too late', actorId: fx.adminId,
    })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.code).toBe('PARTLY_FULFILLED')
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
