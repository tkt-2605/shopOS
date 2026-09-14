import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { businessDate } from '../dates.js'
import { ZERO, type Money } from '../money.js'
import { QTY_SCALE, qty as asQty, type Qty } from '../quantity.js'
import { computeTotals } from '../domain/billTotals.js'
import { supplyTypeFor, type SupplyType } from '../domain/tax.js'
import { resolveSaleUnit, pricingContextFor, resolveLinePrice } from '../repos/pricing.js'
import { getSetting } from './bootstrap.js'
import { nextDocNo } from './numbering.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'

/**
 * Quotations, sales orders and purchase orders.
 *
 * One engine for three documents, because they differ in who they are addressed
 * to and what they turn into — not in what they are. Each is a party, a list of
 * lines, a set of totals and a promise.
 *
 * Nothing here moves stock. A submitted order writes no ledger row: that is what
 * `affectsLedgers` decides, and these answer no. Reserving stock against an
 * order would touch every stock query in the product and is its own decision.
 *
 * Prices are not resolved differently from the counter. `resolveLinePrice` and
 * `computeTotals` are the same functions `billing.ts` calls, with the same
 * arguments — a quotation that quoted a price the till then disagreed with
 * would be worse than no quotation at all.
 */

export type DocumentKind = 'quotation' | 'sales_order' | 'purchase_order'

export interface DocumentLineInput {
  productId: string
  saleUnit?: string | null
  qty: Qty
  /** A rate someone typed, kept rather than resolved. */
  rateOverride?: Money | null
  discount?: Money
}

export interface CreateDocumentInput {
  kind: DocumentKind
  registerId: string
  customerId?: string | null
  supplierId?: string | null
  lines: DocumentLineInput[]
  postingDate?: string
  /** After this date the quoted price is no longer the shop's promise. */
  validUntil?: string | null
  notes?: string | null
  terms?: string | null
  /** Set by `convert.ts`; the document this one was made from. */
  convertedFrom?: string | null
  actorId: string
  now?: Date
}

export type CreateDocumentResult =
  | { ok: true; documentId: string; docNo: string; grandTotal: Money }
  | { ok: false; code: 'NO_LINES' | 'INVALID_QTY' | 'UNKNOWN_PRODUCT' | 'PARTY_REQUIRED'; productId?: string }

export async function createDocument(
  db: SqlDriver,
  input: CreateDocumentInput,
): Promise<CreateDocumentResult> {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }

  /* A purchase order with no supplier is an order placed with nobody, and a
     quotation with no customer cannot be handed to anyone. Both are refused
     here rather than stored as a document that can never be acted on. */
  const forSupplier = input.kind === 'purchase_order'
  if (forSupplier && !input.supplierId) return { ok: false, code: 'PARTY_REQUIRED' }
  if (!forSupplier && !input.customerId) return { ok: false, code: 'PARTY_REQUIRED' }

  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const postingDate = input.postingDate ?? businessDate(now)

  const party = forSupplier
    ? await db.get<{ name: string }>(`SELECT name FROM suppliers WHERE id = ?`, [input.supplierId ?? null])
    : await db.get<{ name: string; state_code: string | null }>(
      `SELECT name, state_code FROM customers WHERE id = ?`, [input.customerId ?? null],
    )

  const supply = await supplyFor(db, (party as { state_code?: string | null })?.state_code ?? null)
  const pricing = await pricingContextFor(db, input.customerId ?? null)

  const priced: PricedLine[] = []
  for (const line of input.lines) {
    if (line.qty <= 0) return { ok: false, code: 'INVALID_QTY', productId: line.productId }

    const product = await db.get<{
      id: string; name: string; hsn_code: string | null; tax_rate_bp: number; discount_blocked: number
    }>(
      `SELECT id, name, hsn_code, tax_rate_bp, discount_blocked
         FROM products WHERE id = ? AND deleted_at IS NULL`,
      [line.productId],
    )
    if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT', productId: line.productId }

    const unit = await resolveSaleUnit(db, line.productId, line.saleUnit ?? null)
    const rate = line.rateOverride != null
      ? line.rateOverride
      : (await resolveLinePrice(
        db, pricing, { productId: line.productId, saleUnit: unit.saleUnit, qty: line.qty }, now,
      )).rate

    priced.push({
      productId: product.id,
      productName: product.name,
      hsnCode: product.hsn_code,
      saleUnit: unit.saleUnit,
      qty: line.qty,
      baseQty: asQty(Math.round((line.qty * unit.baseUnits) / QTY_SCALE)),
      rate,
      discount: line.discount ?? ZERO,
      taxRateBp: product.tax_rate_bp,
      discountBlocked: product.discount_blocked === 1,
    })
  }

  const totals = computeTotals(priced, ZERO, supply)
  const documentId = newId()
  let docNo = ''

  await db.transaction(async (tx) => {
    const register = await tx.get<{ prefix: string }>(
      `SELECT prefix FROM registers WHERE id = ?`, [input.registerId],
    )
    docNo = await nextDocNo(tx, input.kind, register?.prefix ?? 'MR', now)

    await tx.execute(
      `INSERT INTO documents (
         id, doc_no, kind, docstatus, register_id,
         customer_id, customer_name, supplier_id, supplier_name,
         posting_date, valid_until,
         subtotal, discount, taxable_total, tax_total, round_off, grand_total,
         place_of_supply, notes, terms, converted_from,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        documentId, docNo, input.kind, input.registerId,
        forSupplier ? null : input.customerId ?? null,
        forSupplier ? null : party?.name ?? null,
        forSupplier ? input.supplierId ?? null : null,
        forSupplier ? party?.name ?? null : null,
        postingDate, input.validUntil ?? null,
        totals.subtotal, totals.discount, totals.taxableTotal, totals.taxTotal, totals.grandTotal,
        supply === 'inter_state' ? 'inter_state' : 'intra_state',
        input.notes ?? null, input.terms ?? null, input.convertedFrom ?? null,
        input.actorId, nowIso, nowIso,
      ],
    )

    for (const [i, line] of priced.entries()) {
      const computed = totals.lines[i]!
      await tx.execute(
        `INSERT INTO document_items (
           id, document_id, idx, product_id, product_name, hsn_code, sale_unit,
           qty, base_qty, rate, discount, line_total,
           taxable_value, tax_rate_bp, cgst_amount, sgst_amount, igst_amount, fulfilled_qty
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          newId(), documentId, i, line.productId, line.productName, line.hsnCode, line.saleUnit,
          line.qty, line.baseQty, line.rate, line.discount, computed.lineTotal,
          computed.tax.taxableValue, line.taxRateBp,
          computed.tax.cgst, computed.tax.sgst, computed.tax.igst,
        ],
      )
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: documentId,
      action: 'create',
      after: { doc_no: docNo, kind: input.kind, grand_total: totals.grandTotal },
      docstatusTo: 0,
    })
  })

  return { ok: true, documentId, docNo, grandTotal: totals.grandTotal }
}

export type SubmitDocumentResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_SUBMITTED' | 'CANCELLED' }

/**
 * Committing to the document.
 *
 * Submitting moves no stock and no money. What it changes is that the document
 * can no longer be edited, and that it becomes something another document can be
 * made from — which is the whole of what `docstatus = 1` means here.
 */
export async function submitDocument(
  db: SqlDriver,
  input: { documentId: string; actorId: string; now?: Date },
): Promise<SubmitDocumentResult> {
  const doc = await db.get<{ docstatus: number }>(
    `SELECT docstatus FROM documents WHERE id = ?`, [input.documentId],
  )
  if (!doc) return { ok: false, code: 'NOT_FOUND' }
  if (doc.docstatus === 1) return { ok: false, code: 'ALREADY_SUBMITTED' }
  if (doc.docstatus === 2) return { ok: false, code: 'CANCELLED' }

  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE documents SET docstatus = 1, updated_at = ? WHERE id = ?`,
      [nowIso, input.documentId],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: input.documentId,
      action: 'submit',
      docstatusFrom: 0,
      docstatusTo: 1,
    })
  })

  return { ok: true }
}

export type CancelDocumentResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_CANCELLED' | 'PARTLY_FULFILLED'; fulfilled?: number }

export async function cancelDocument(
  db: SqlDriver,
  input: { documentId: string; reason: string; actorId: string; now?: Date },
): Promise<CancelDocumentResult> {
  const doc = await db.get<{ docstatus: number }>(
    `SELECT docstatus FROM documents WHERE id = ?`, [input.documentId],
  )
  if (!doc) return { ok: false, code: 'NOT_FOUND' }
  if (doc.docstatus === 2) return { ok: false, code: 'ALREADY_CANCELLED' }

  /* An order that has already been part-billed cannot be cancelled: the bill
     exists and the goods are gone. Cancelling the order it came from would
     leave the bill pointing at a document that says it never happened. */
  const done = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM document_items WHERE document_id = ? AND fulfilled_qty > 0`,
    [input.documentId],
  )
  if ((done?.n ?? 0) > 0) return { ok: false, code: 'PARTLY_FULFILLED', fulfilled: done!.n }

  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE documents
          SET docstatus = 2, cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ?`,
      [input.actorId, nowIso, input.reason, nowIso, input.documentId],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: input.documentId,
      action: 'cancel',
      after: { cancel_reason: input.reason },
      docstatusFrom: doc.docstatus as 0 | 1,
      docstatusTo: 2,
    })
  })

  return { ok: true }
}

/* ------------------------------------------------------------ reading --- */

export interface DocumentListItem {
  id: string
  docNo: string
  kind: DocumentKind
  docstatus: number
  postingDate: string
  validUntil: string | null
  partyName: string | null
  grandTotal: Money
  /** Nothing billed yet, some of it, or all of it. */
  progress: 'open' | 'part' | 'done'
}

/**
 * Which documents a screen is asking for.
 *
 * A draft is a real state here in a way it is not for a bill: a quotation gets
 * started while the customer is on the phone and finished after someone has
 * checked a price, so it has to be findable in between. `issued` is the default
 * because that is what a list of quotations usually means.
 */
export type DocumentStatus = 'draft' | 'issued' | 'cancelled' | 'all'

export interface DocumentFilter {
  kind?: DocumentKind
  status?: DocumentStatus
  from?: string
  to?: string
  search?: string
  limit?: number
  offset?: number
}

const DOCSTATUS_OF: Record<Exclude<DocumentStatus, 'all'>, number> = {
  draft: 0, issued: 1, cancelled: 2,
}

export async function listDocuments(
  db: SqlDriver,
  filter: DocumentFilter = {},
): Promise<DocumentListItem[]> {
  // Seeded, because asking for everything with no other filter would otherwise
  // leave a bare WHERE.
  const where: string[] = ['1 = 1']
  const params: (string | number)[] = []

  // Unasked, the list is what has been issued — not drafts, which are somebody
  // midway through a job, and not cancelled ones.
  const status = filter.status ?? 'issued'
  if (status !== 'all') { where.push('d.docstatus = ?'); params.push(DOCSTATUS_OF[status]) }

  if (filter.kind) { where.push('d.kind = ?'); params.push(filter.kind) }
  if (filter.from) { where.push('d.posting_date >= ?'); params.push(filter.from) }
  if (filter.to) { where.push('d.posting_date <= ?'); params.push(filter.to) }
  if (filter.search) {
    where.push('(d.doc_no LIKE ? OR d.customer_name LIKE ? OR d.supplier_name LIKE ?)')
    const like = `%${filter.search}%`
    params.push(like, like, like)
  }

  params.push(filter.limit ?? 100, filter.offset ?? 0)

  const rows = await db.query<{
    id: string; doc_no: string; kind: DocumentKind; docstatus: number
    posting_date: string; valid_until: string | null
    party_name: string | null; grand_total: number
    lines: number; started: number; finished: number
  }>(
    `SELECT d.id, d.doc_no, d.kind, d.docstatus, d.posting_date, d.valid_until,
            COALESCE(d.customer_name, d.supplier_name) AS party_name,
            d.grand_total,
            COUNT(i.id) AS lines,
            SUM(CASE WHEN i.fulfilled_qty > 0 THEN 1 ELSE 0 END) AS started,
            SUM(CASE WHEN i.fulfilled_qty >= i.qty THEN 1 ELSE 0 END) AS finished
       FROM documents d
       LEFT JOIN document_items i ON i.document_id = d.id
      WHERE ${where.join(' AND ')}
      GROUP BY d.id
      ORDER BY d.posting_date DESC, d.created_at DESC
      LIMIT ? OFFSET ?`,
    params,
  )

  return rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    kind: r.kind,
    docstatus: r.docstatus,
    postingDate: r.posting_date,
    validUntil: r.valid_until,
    partyName: r.party_name,
    grandTotal: r.grand_total as Money,
    progress: r.finished === r.lines && r.lines > 0 ? 'done' : r.started > 0 ? 'part' : 'open',
  }))
}

export interface DocumentItemRow {
  id: string
  productId: string
  productName: string
  hsnCode: string | null
  saleUnit: string
  qty: Qty
  rate: Money
  discount: Money
  lineTotal: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  fulfilledQty: Qty
  /** What is still to be billed or received on this line. */
  remainingQty: Qty
}

export interface DocumentDetail extends DocumentListItem {
  customerId: string | null
  supplierId: string | null
  subtotal: Money
  discount: Money
  taxableTotal: Money
  taxTotal: Money
  notes: string | null
  terms: string | null
  convertedFrom: string | null
  cancelReason: string | null
  createdBy: string
  items: DocumentItemRow[]
}

export async function loadDocument(db: SqlDriver, id: string): Promise<DocumentDetail | null> {
  const row = await db.get<Record<string, never>>(
    `SELECT d.*, COALESCE(d.customer_name, d.supplier_name) AS party_name,
            u.full_name AS created_by_name
       FROM documents d
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.id = ?`,
    [id],
  ) as Record<string, string | number | null> | undefined
  if (!row) return null

  const items = await db.query<Record<string, string | number | null>>(
    `SELECT * FROM document_items WHERE document_id = ? ORDER BY idx`, [id],
  )

  const lines = items.map((i) => ({
    id: i['id'] as string,
    productId: i['product_id'] as string,
    productName: i['product_name'] as string,
    hsnCode: i['hsn_code'] as string | null,
    saleUnit: i['sale_unit'] as string,
    qty: i['qty'] as Qty,
    rate: i['rate'] as Money,
    discount: i['discount'] as Money,
    lineTotal: i['line_total'] as Money,
    taxableValue: i['taxable_value'] as Money,
    cgst: i['cgst_amount'] as Money,
    sgst: i['sgst_amount'] as Money,
    igst: i['igst_amount'] as Money,
    fulfilledQty: i['fulfilled_qty'] as Qty,
    remainingQty: Math.max(0, (i['qty'] as number) - (i['fulfilled_qty'] as number)) as Qty,
  }))

  const started = lines.filter((l) => l.fulfilledQty > 0).length
  const finished = lines.filter((l) => l.fulfilledQty >= l.qty).length

  return {
    id: row['id'] as string,
    docNo: row['doc_no'] as string,
    kind: row['kind'] as DocumentKind,
    docstatus: row['docstatus'] as number,
    postingDate: row['posting_date'] as string,
    validUntil: row['valid_until'] as string | null,
    partyName: row['party_name'] as string | null,
    customerId: row['customer_id'] as string | null,
    supplierId: row['supplier_id'] as string | null,
    subtotal: row['subtotal'] as Money,
    discount: row['discount'] as Money,
    taxableTotal: row['taxable_total'] as Money,
    taxTotal: row['tax_total'] as Money,
    grandTotal: row['grand_total'] as Money,
    notes: row['notes'] as string | null,
    terms: row['terms'] as string | null,
    convertedFrom: row['converted_from'] as string | null,
    cancelReason: row['cancel_reason'] as string | null,
    createdBy: (row['created_by_name'] ?? row['created_by']) as string,
    progress: finished === lines.length && lines.length > 0 ? 'done' : started > 0 ? 'part' : 'open',
    items: lines,
  }
}

/**
 * Marks an order off against the bill that is paying for it.
 *
 * Runs inside `submitBill`'s own transaction, and that is the entire point: an
 * order is marked off by the payment, never by the cart. A cashier who pulls an
 * order onto the counter and is then interrupted has delivered nothing, and an
 * order the shop believes it has already sent out is a worse record than one
 * that says nothing at all.
 *
 * Matching is by item, taking the oldest unfinished line first. Quantities go
 * through each order line's own base ratio, so a bill written in pieces marks
 * off an order written in dozens.
 *
 * What it took is written down rather than inferred, because cancelling the
 * bill has to give back exactly what this bill took — and by then another bill
 * may have consumed the rest of the line, so the share cannot be worked out
 * again afterwards.
 */
export async function applyBillFulfilment(
  tx: SqlDriver,
  input: { billId: string; documentId: string; actorId: string; now: Date },
): Promise<void> {
  /* Summed per item: one order line can be billed across two lines of the same
     cart, and two cart lines competing for the same remainder would each see it
     as whole. */
  const billed = await tx.query<{ product_id: string; base_qty: number }>(
    `SELECT product_id, SUM(base_qty) AS base_qty
       FROM bill_items WHERE bill_id = ? GROUP BY product_id`,
    [input.billId],
  )
  if (billed.length === 0) return

  const lines = await tx.query<{
    id: string; product_id: string; qty: number; base_qty: number; fulfilled_qty: number
  }>(
    `SELECT id, product_id, qty, base_qty, fulfilled_qty
       FROM document_items WHERE document_id = ? ORDER BY idx`,
    [input.documentId],
  )
  if (lines.length === 0) return

  const nowIso = input.now.toISOString()
  let marked = 0

  for (const sold of billed) {
    let leftInBase = sold.base_qty

    for (const line of lines) {
      if (leftInBase <= 0) break
      if (line.product_id !== sold.product_id) continue

      const remaining = line.qty - line.fulfilled_qty
      if (remaining <= 0) continue

      const remainingInBase = Math.round((remaining * line.base_qty) / line.qty)
      const takenInBase = Math.min(leftInBase, remainingInBase)
      const taken = Math.min(remaining, Math.round((takenInBase * line.qty) / line.base_qty))
      /* A bill line smaller than one thousandth of an order line's unit rounds
         to nothing here. It is left alone rather than marked off as zero: an
         order that says it is short by an amount nobody can see is still true. */
      if (taken <= 0) continue

      await tx.execute(
        `UPDATE document_items SET fulfilled_qty = fulfilled_qty + ? WHERE id = ?`,
        [taken, line.id],
      )
      await tx.execute(
        `INSERT INTO bill_fulfilments (id, bill_id, document_id, document_item_id, qty, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), input.billId, input.documentId, line.id, taken, nowIso],
      )

      line.fulfilled_qty += taken
      leftInBase -= takenInBase
      marked += 1
    }
  }

  /* Nothing on the bill answered anything still open on the order — a cart
     emptied and refilled with other items, most often. The bill stands; the
     order is simply not touched, and the audit row is not written either,
     because no change was made to record. */
  if (marked === 0) return

  await writeAudit(tx, { actorId: input.actorId }, {
    entity: 'document',
    entityId: input.documentId,
    action: 'update',
    after: { billed_by: input.billId },
  })
}

/**
 * Gives back what a cancelled bill had taken.
 *
 * Reads the working rather than recomputing the share: this bill's rows say
 * exactly what it marked off, and they are the only answer that stays right
 * once a later bill has taken the rest of the line.
 */
export async function reverseBillFulfilment(
  tx: SqlDriver,
  input: { billId: string; actorId: string },
): Promise<void> {
  const taken = await tx.query<{ document_id: string; document_item_id: string; qty: number }>(
    `SELECT document_id, document_item_id, qty FROM bill_fulfilments WHERE bill_id = ?`,
    [input.billId],
  )
  if (taken.length === 0) return

  for (const row of taken) {
    await tx.execute(
      `UPDATE document_items SET fulfilled_qty = MAX(0, fulfilled_qty - ?) WHERE id = ?`,
      [row.qty, row.document_item_id],
    )
  }
  await tx.execute(`DELETE FROM bill_fulfilments WHERE bill_id = ?`, [input.billId])

  for (const documentId of new Set(taken.map((t) => t.document_id))) {
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: documentId,
      action: 'update',
      after: { unbilled_by: input.billId },
    })
  }
}

/* ------------------------------------------------------------ private --- */

interface PricedLine {
  productId: string
  productName: string
  hsnCode: string | null
  saleUnit: string
  qty: Qty
  baseQty: Qty
  rate: Money
  discount: Money
  taxRateBp: number
  discountBlocked: boolean
}

async function supplyFor(db: SqlDriver, partyStateCode: string | null): Promise<SupplyType> {
  const shopState = await getSetting(db, 'shop_state_code')
  return supplyTypeFor(shopState, partyStateCode)
}
