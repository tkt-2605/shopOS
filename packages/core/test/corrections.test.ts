import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import {
  amendStockEntry, saveStockEntryDraft, discardStockEntryDraft, loadEntryToEdit,
} from '../src/services/stockEntryEdit.js'
import { loadStockEntry } from '../src/repos/stockEntries.js'
import { createDocument, submitDocument, loadDocument, amendDocument } from '../src/services/documents.js'
import { quotationToSalesOrder } from '../src/services/convert.js'
import { currentStock } from '../src/services/stock.js'
import { ledgerChecks } from '../src/repos/ledger.js'
import { createSupplier } from '../src/services/suppliers.js'
import { rupees } from '../src/money.js'
import { fromUnits, type Qty } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Correcting what was saved: a purchase posted with a mistake in it, and an
 * issued quotation or order. Neither is ever rewritten -- each is cancelled
 * and a corrected one posted in its place, in one transaction -- and a draft
 * purchase is kept to finish later.
 */

let fx: Fixture
let pen: string
let supplierId: string

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'Ball Pen', baseRate: rupees(10), taxRateBp: 1800 })
  const s = await createSupplier(fx.db, { name: 'Mill', actorId: fx.adminId })
  if (!s.ok) throw new Error('no supplier')
  supplierId = s.supplierId
})
afterEach(async () => { await fx.db.close() })

const units = (n: number) => fromUnits(n) as Qty

async function buy(qty: number, cost: number) {
  const made = await createStockEntry(fx.db, {
    entryType: 'purchase', supplierId, actorId: fx.adminId,
    lines: [{ productId: pen, qty: units(qty), unitCost: rupees(cost), taxRateBp: 1800 }],
  })
  if (!made.ok) throw new Error(made.code)
  const posted = await submitStockEntry(fx.db, { entryId: made.entryId, actorId: fx.adminId })
  if (!posted.ok) throw new Error(posted.code)
  return { entryId: made.entryId, docNo: posted.docNo }
}

async function sell(qty: number) {
  const bill = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: pen, qty: units(qty) }], actorId: fx.adminId,
  })
  if (!bill.ok) throw new Error(bill.code)
  const paid = await submitBill(fx.db, { billId: bill.billId, payments: [{ method: 'cash', amount: bill.grandTotal }], actorId: fx.adminId })
  if (!paid.ok) throw new Error(paid.code)
}

const corrected = (entryId: string, qty: number, cost: number) => amendStockEntry(fx.db, {
  entryId, entryType: 'purchase', supplierId, actorId: fx.adminId,
  lines: [{ productId: pen, qty: units(qty), unitCost: rupees(cost), taxRateBp: 1800 }],
})

describe('a posted purchase, corrected', () => {
  it('is cancelled and a corrected one posted, naming it, with the stock and books as the correction says', async () => {
    const first = await buy(10, 5)
    const fixed = await corrected(first.entryId, 12, 6)
    if (!fixed.ok) throw new Error(fixed.code)

    expect(fixed.replaced).toBe(first.docNo)
    expect(fixed.docNo).not.toBe(first.docNo)
    expect(await currentStock(fx.db, pen)).toBe(units(12))
    const old = await loadStockEntry(fx.db, first.entryId)
    const now = await loadStockEntry(fx.db, fixed.entryId)
    expect(old?.docstatus).toBe(2)
    expect(old?.correctedBy).toBe(fixed.docNo)
    expect(now?.corrects).toBe(first.docNo)
    expect(now?.invoiceTotal).toBe(rupees(12 * 6 * 1.18))
    const checks = await ledgerChecks(fx.db)
    expect(checks.unbalanced).toEqual([])
    expect(checks.stockDrift).toBe(0)
  })

  it('takes a rate fixed on goods already half sold', async () => {
    const first = await buy(10, 5)
    await sell(6)
    const fixed = await corrected(first.entryId, 10, 7)
    expect(fixed.ok).toBe(true)
    expect(await currentStock(fx.db, pen)).toBe(units(4))
  })

  it('refuses a quantity cut below what has been sold, and leaves the original posted', async () => {
    const first = await buy(10, 5)
    await sell(6)
    const fixed = await corrected(first.entryId, 3, 5)
    expect(fixed).toMatchObject({ ok: false, code: 'WOULD_GO_NEGATIVE', productId: pen })
    expect((await loadStockEntry(fx.db, first.entryId))?.docstatus).toBe(1)
    expect(await currentStock(fx.db, pen)).toBe(units(4))
    const entries = await fx.db.query<{ n: number }>(`SELECT count(*) AS n FROM stock_entries`)
    expect(entries[0]!.n).toBe(1)
  })

  it('refuses one that is not posted', async () => {
    const draft = await saveStockEntryDraft(fx.db, {
      entryType: 'purchase', supplierId, actorId: fx.adminId,
      lines: [{ productId: pen, qty: units(2), unitCost: rupees(5) }],
    })
    if (!draft.ok) throw new Error(draft.code)
    expect(await corrected(draft.entryId, 3, 5)).toMatchObject({ ok: false, code: 'NOT_POSTED' })
  })
})

describe('a purchase kept as a draft', () => {
  it('moves nothing, comes back as typed, and saved again replaces itself', async () => {
    const first = await saveStockEntryDraft(fx.db, {
      entryType: 'purchase', supplierId, supplierInvoiceNo: 'INV-7', actorId: fx.adminId,
      lines: [{ productId: pen, qty: units(5), unitCost: rupees(4), taxRateBp: 1200 }],
    })
    if (!first.ok) throw new Error(first.code)
    expect(await currentStock(fx.db, pen)).toBe(0)

    const back = await loadEntryToEdit(fx.db, first.entryId)
    expect(back).toMatchObject({ docstatus: 0, supplierId, supplierInvoiceNo: 'INV-7' })
    expect(back?.lines).toMatchObject([{ productId: pen, qty: units(5), unitCost: rupees(4), taxRateBp: 1200 }])

    const again = await saveStockEntryDraft(fx.db, {
      draftId: first.entryId, entryType: 'purchase', supplierId, actorId: fx.adminId,
      lines: [{ productId: pen, qty: units(8), unitCost: rupees(4) }],
    })
    if (!again.ok) throw new Error(again.code)
    const drafts = await fx.db.query<{ id: string }>(`SELECT id FROM stock_entries WHERE docstatus = 0`)
    expect(drafts.map((d) => d.id)).toEqual([again.entryId])

    const posted = await submitStockEntry(fx.db, { entryId: again.entryId, actorId: fx.adminId })
    expect(posted.ok).toBe(true)
    expect(await currentStock(fx.db, pen)).toBe(units(8))
  })

  it('is discarded without a trace on the shelf', async () => {
    const draft = await saveStockEntryDraft(fx.db, {
      entryType: 'purchase', supplierId, actorId: fx.adminId,
      lines: [{ productId: pen, qty: units(5), unitCost: rupees(4) }],
    })
    if (!draft.ok) throw new Error(draft.code)
    expect(await discardStockEntryDraft(fx.db, { entryId: draft.entryId, actorId: fx.adminId })).toEqual({ ok: true })
    expect(await loadEntryToEdit(fx.db, draft.entryId)).toBeNull()
  })
})

describe('an issued quotation, corrected', () => {
  async function quote(qty: number) {
    const customerId = await makeCustomer(fx.db)
    const made = await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId,
      lines: [{ productId: pen, qty: units(qty) }], actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(made.code)
    await submitDocument(fx.db, { documentId: made.documentId, actorId: fx.adminId })
    return { ...made, customerId }
  }

  it('is cancelled, and the correction issued under its own number, naming it', async () => {
    const q1 = await quote(5)
    const fixed = await amendDocument(fx.db, {
      documentId: q1.documentId, registerId: fx.seed.registerId, customerId: q1.customerId,
      lines: [{ productId: pen, qty: units(7) }], actorId: fx.adminId,
    })
    if (!fixed.ok) throw new Error(fixed.code)
    expect(fixed.replaced).toBe(q1.docNo)

    const old = await loadDocument(fx.db, q1.documentId)
    const now = await loadDocument(fx.db, fixed.documentId)
    expect(old).toMatchObject({ docstatus: 2, correctedBy: fixed.docNo })
    expect(now).toMatchObject({ docstatus: 1, corrects: q1.docNo, kind: 'quotation' })
    expect(now?.items[0]?.qty).toBe(units(7))
  })

  it('refuses one an order has been made from, and leaves it as it was', async () => {
    const q1 = await quote(5)
    const order = await quotationToSalesOrder(fx.db, { quotationId: q1.documentId, actorId: fx.adminId })
    expect(order.ok).toBe(true)
    const fixed = await amendDocument(fx.db, {
      documentId: q1.documentId, registerId: fx.seed.registerId, customerId: q1.customerId,
      lines: [{ productId: pen, qty: units(7) }], actorId: fx.adminId,
    })
    expect(fixed.ok).toBe(false)
    expect((await loadDocument(fx.db, q1.documentId))?.docstatus).toBe(1)
    const docs = await fx.db.query<{ n: number }>(`SELECT count(*) AS n FROM documents WHERE amended_from IS NOT NULL`)
    expect(docs[0]!.n).toBe(0)
  })
})
