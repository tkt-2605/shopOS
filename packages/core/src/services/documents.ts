import { eq, and, or, isNull, gte, lte, asc, desc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { businessDate } from '../dates.js'
import { ZERO, type Money } from '../money.js'
import { QTY_SCALE, qty as asQty, type Qty } from '../quantity.js'
import { computeTotals } from '../domain/billTotals.js'
import { loadRounding } from './features.js'
import { supplyTypeFor, type SupplyType } from '../domain/tax.js'
import { resolveSaleUnit, pricingContextFor, resolveLinePrice } from '../repos/pricing.js'
import { getSetting } from './bootstrap.js'
import { nextDocNo } from './numbering.js'
import { writeAudit } from '../integrity/audit.js'

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

  /* One shape for both, so the caller below does not have to know which table
     the name came out of. A supplier has no state code here: a purchase order
     is not a supply by this shop and carries no place of supply. */
  const [party] = forSupplier
    ? await q(db)
        .select({ name: schema.suppliers.name, stateCode: sql<string | null>`NULL` })
        .from(schema.suppliers)
        .where(eq(schema.suppliers.id, input.supplierId ?? ''))
    : await q(db)
        .select({ name: schema.customers.name, stateCode: schema.customers.stateCode })
        .from(schema.customers)
        .where(eq(schema.customers.id, input.customerId ?? ''))

  const supply = await supplyFor(db, party?.stateCode ?? null)
  const pricing = await pricingContextFor(db, input.customerId ?? null)

  const priced: PricedLine[] = []
  for (const line of input.lines) {
    if (line.qty <= 0) return { ok: false, code: 'INVALID_QTY', productId: line.productId }

    const [product] = await q(db)
      .select({
        id: schema.products.id,
        name: schema.products.name,
        hsnCode: schema.products.hsnCode,
        taxRateBp: schema.products.taxRateBp,
        discountBlocked: schema.products.discountBlocked,
      })
      .from(schema.products)
      .where(and(eq(schema.products.id, line.productId), isNull(schema.products.deletedAt)))
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
      hsnCode: product.hsnCode,
      saleUnit: unit.saleUnit,
      qty: line.qty,
      baseQty: asQty(Math.round((line.qty * unit.baseUnits) / QTY_SCALE)),
      rate,
      discount: line.discount ?? ZERO,
      taxRateBp: product.taxRateBp,
      discountBlocked: product.discountBlocked === 1,
    })
  }

  /* Rounded by the shop's own rule, like a bill. A quotation for ₹99.60 that
     becomes a bill for ₹100 has quoted the wrong number, and the difference is
     the one a customer notices. */
  const totals = computeTotals(priced, ZERO, supply, await loadRounding(db))
  const documentId = newId()
  let docNo = ''

  await db.transaction(async (tx) => {
    const [register] = await q(tx)
      .select({ prefix: schema.registers.prefix })
      .from(schema.registers)
      .where(eq(schema.registers.id, input.registerId))
    docNo = await nextDocNo(tx, input.kind, register?.prefix ?? 'MR', now)

    await q(tx).insert(schema.documents).values({
      id: documentId,
      docNo,
      kind: input.kind,
      docstatus: 0,
      registerId: input.registerId,
      customerId: forSupplier ? null : input.customerId ?? null,
      customerName: forSupplier ? null : party?.name ?? null,
      supplierId: forSupplier ? input.supplierId ?? null : null,
      supplierName: forSupplier ? party?.name ?? null : null,
      postingDate,
      validUntil: input.validUntil ?? null,
      subtotal: totals.subtotal,
      discount: totals.discount,
      taxableTotal: totals.taxableTotal,
      taxTotal: totals.taxTotal,
      roundOff: totals.roundOff,
      grandTotal: totals.grandTotal,
      placeOfSupply: supply === 'inter_state' ? 'inter_state' : 'intra_state',
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      convertedFrom: input.convertedFrom ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    for (const [i, line] of priced.entries()) {
      const computed = totals.lines[i]!
      await q(tx).insert(schema.documentItems).values({
        id: newId(),
        documentId,
        idx: i,
        productId: line.productId,
        productName: line.productName,
        hsnCode: line.hsnCode,
        saleUnit: line.saleUnit,
        qty: line.qty,
        baseQty: line.baseQty,
        rate: line.rate,
        discount: line.discount,
        lineTotal: computed.lineTotal,
        taxableValue: computed.tax.taxableValue,
        taxRateBp: line.taxRateBp,
        cgstAmount: computed.tax.cgst,
        sgstAmount: computed.tax.sgst,
        igstAmount: computed.tax.igst,
      })
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
  const [doc] = await q(db)
    .select({ docstatus: schema.documents.docstatus })
    .from(schema.documents)
    .where(eq(schema.documents.id, input.documentId))
  if (!doc) return { ok: false, code: 'NOT_FOUND' }
  if (doc.docstatus === 1) return { ok: false, code: 'ALREADY_SUBMITTED' }
  if (doc.docstatus === 2) return { ok: false, code: 'CANCELLED' }

  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.documents)
      .set({ docstatus: 1, updatedAt: nowIso })
      .where(eq(schema.documents.id, input.documentId))
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
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_CANCELLED' }
  /**
   * Some of it has been acted on, but not all.
   *
   * Separate from `FULLY_FULFILLED` because the two need different sentences
   * and a different way out. Part-done has a remainder somebody may still want,
   * so the answer is a fresh document for what is left; all-done has no
   * remainder and nothing to raise.
   */
  | { ok: false; code: 'PARTLY_FULFILLED'; fulfilled: number; lines: number }
  | { ok: false; code: 'FULLY_FULFILLED'; lines: number }

export async function cancelDocument(
  db: SqlDriver,
  input: { documentId: string; reason: string; actorId: string; now?: Date },
): Promise<CancelDocumentResult> {
  const [doc] = await q(db)
    .select({ docstatus: schema.documents.docstatus })
    .from(schema.documents)
    .where(eq(schema.documents.id, input.documentId))
  if (!doc) return { ok: false, code: 'NOT_FOUND' }
  if (doc.docstatus === 2) return { ok: false, code: 'ALREADY_CANCELLED' }

  /* An order that has already been billed cannot be cancelled: the bill exists
     and the goods are gone. Cancelling the order it came from would leave the
     bill pointing at a document that says it never happened.

     Counted two ways so the refusal can say which it is. A quotation every line
     of which has been billed is not "partly" anything -- it is finished, and
     telling a shopkeeper that part of it has been delivered when all of it has
     sends them looking for the missing part. */
  const [done] = await q(db)
    .select({
      lines: sql<number>`COUNT(*)`,
      started: STARTED,
      finished: FINISHED,
    })
    .from(schema.documentItems)
    .where(eq(schema.documentItems.documentId, input.documentId))
  const lines = done?.lines ?? 0
  const started = done?.started ?? 0
  if (lines > 0 && (done?.finished ?? 0) === lines) {
    return { ok: false, code: 'FULLY_FULFILLED', lines }
  }
  if (started > 0) return { ok: false, code: 'PARTLY_FULFILLED', fulfilled: started, lines }

  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.documents)
      .set({
        docstatus: 2,
        cancelledBy: input.actorId,
        cancelledAt: nowIso,
        cancelReason: input.reason,
        updatedAt: nowIso,
      })
      .where(eq(schema.documents.id, input.documentId))
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
/**
 * `completed` is a view of an issued document, not a fourth `docstatus`.
 *
 * ERPNext's docstatus has three values and inventing a fourth would put a state
 * into the database that no other rule knows about. "Everything on it has been
 * billed" is already derivable from the lines -- it is the same arithmetic
 * `progress` reports -- so it belongs in the filter and not in the column.
 *
 * It matters because `issued` without it is a list a shopkeeper cannot work
 * from: a quotation that was won and billed a month ago sits in it for ever,
 * beside the ones still waiting for an answer.
 */
export type DocumentStatus = 'draft' | 'issued' | 'open' | 'completed' | 'cancelled' | 'all'

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
  draft: 0, issued: 1, open: 1, completed: 1, cancelled: 2,
}

export async function listDocuments(
  db: SqlDriver,
  filter: DocumentFilter = {},
): Promise<DocumentListItem[]> {
  // Unasked, the list is what has been issued — not drafts, which are somebody
  // midway through a job, and not cancelled ones.
  const status = filter.status ?? 'issued'
  const like = filter.search ? `%${filter.search}%` : null

  const lines = sql<number>`COUNT(${schema.documentItems.id})`

  /* `open` and `completed` are the same docstatus told apart by their lines, so
     they filter after the grouping rather than before it. A document with no
     lines at all is neither: it cannot be finished, because there is nothing on
     it to finish. */
  const having =
    status === 'completed' ? sql`${lines} > 0 AND ${FINISHED} = ${lines}`
    : status === 'open' ? sql`${lines} = 0 OR ${FINISHED} < ${lines}`
    : undefined

  const rows = await q(db)
    .select({
      id: schema.documents.id,
      docNo: schema.documents.docNo,
      kind: schema.documents.kind,
      docstatus: schema.documents.docstatus,
      postingDate: schema.documents.postingDate,
      validUntil: schema.documents.validUntil,
      partyName: sql<string | null>`COALESCE(${schema.documents.customerName}, ${schema.documents.supplierName})`,
      grandTotal: schema.documents.grandTotal,
      lines,
      started: STARTED,
      finished: FINISHED,
    })
    .from(schema.documents)
    .leftJoin(schema.documentItems, eq(schema.documentItems.documentId, schema.documents.id))
    .where(and(
      ...(status !== 'all' ? [eq(schema.documents.docstatus, DOCSTATUS_OF[status])] : []),
      ...(filter.kind ? [eq(schema.documents.kind, filter.kind)] : []),
      ...(filter.from ? [gte(schema.documents.postingDate, filter.from)] : []),
      ...(filter.to ? [lte(schema.documents.postingDate, filter.to)] : []),
      ...(like ? [or(
        sql`${schema.documents.docNo} LIKE ${like}`,
        sql`${schema.documents.customerName} LIKE ${like}`,
        sql`${schema.documents.supplierName} LIKE ${like}`,
      )!] : []),
    ))
    .groupBy(schema.documents.id)
    .having(having)
    .orderBy(desc(schema.documents.postingDate), desc(schema.documents.createdAt))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0)

  return rows.map((r) => ({
    id: r.id,
    docNo: r.docNo,
    kind: r.kind as DocumentKind,
    docstatus: r.docstatus,
    postingDate: r.postingDate,
    validUntil: r.validUntil,
    partyName: r.partyName,
    grandTotal: r.grandTotal,
    progress: r.finished === r.lines && r.lines > 0 ? 'done' : r.started > 0 ? 'part' : 'open',
  }))
}

/* How far along a document's lines are, counted two ways.
 *
 * Written once because three callers ask the same two questions and a document
 * that is "partly done" on one screen and "done" on another is a support call.
 * A line is started once anything has been billed against it and finished once
 * everything has; a document is finished when every line is. */
const STARTED = sql<number>`COALESCE(SUM(CASE WHEN ${schema.documentItems.fulfilledQty} > 0 THEN 1 ELSE 0 END), 0)`
const FINISHED = sql<number>`COALESCE(SUM(CASE WHEN ${schema.documentItems.fulfilledQty} >= ${schema.documentItems.qty} THEN 1 ELSE 0 END), 0)`

export interface DocumentItemRow {
  id: string
  productId: string
  productName: string
  hsnCode: string | null
  /** Rule 46(k), for the sheet renderer: the rate, not only the amount. */
  taxRateBp: number
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
  /**
   * Which pair of taxes the document charged.
   *
   * Off `documents.place_of_supply`, which -- unlike the column of the same
   * name on `bills` -- holds `intra_state` or `inter_state` rather than a state
   * code. Named for what it holds here rather than repeating the mistake: the
   * renderer needs to know which tax columns to print, and there is no state in
   * the row to print as a place of supply.
   */
  supplyType: 'intra_state' | 'inter_state' | null
  subtotal: Money
  discount: Money
  taxableTotal: Money
  taxTotal: Money
  /**
   * The paise added or dropped to reach a round figure, signed.
   *
   * Written by `createDocument` since rounding existed and never read back, so
   * a quotation printed its lines, its tax and a grand total that did not add
   * up to them — off by up to 49 paise, with nothing on the sheet to explain
   * the difference. The renderer has had a place to print it all along.
   */
  roundOff: Money
  notes: string | null
  terms: string | null
  convertedFrom: string | null
  cancelReason: string | null
  createdBy: string
  items: DocumentItemRow[]
}

export async function loadDocument(db: SqlDriver, id: string): Promise<DocumentDetail | null> {
  /* Named columns rather than `SELECT *`.
     The two reads here used to come back as `Record<string, string | number |
     null>` and every field was pulled out with a cast -- thirty of them, each
     one a place where a column could be renamed and nothing would say so until
     a screen showed `undefined`. The query names what it wants and the driver
     knows what those columns are. */
  const [row] = await q(db)
    .select({
      id: schema.documents.id,
      docNo: schema.documents.docNo,
      kind: schema.documents.kind,
      docstatus: schema.documents.docstatus,
      postingDate: schema.documents.postingDate,
      validUntil: schema.documents.validUntil,
      partyName: sql<string | null>`COALESCE(${schema.documents.customerName}, ${schema.documents.supplierName})`,
      placeOfSupply: schema.documents.placeOfSupply,
      customerId: schema.documents.customerId,
      supplierId: schema.documents.supplierId,
      subtotal: schema.documents.subtotal,
      discount: schema.documents.discount,
      taxableTotal: schema.documents.taxableTotal,
      taxTotal: schema.documents.taxTotal,
      roundOff: schema.documents.roundOff,
      grandTotal: schema.documents.grandTotal,
      notes: schema.documents.notes,
      terms: schema.documents.terms,
      convertedFrom: schema.documents.convertedFrom,
      cancelReason: schema.documents.cancelReason,
      createdBy: schema.documents.createdBy,
      createdByName: schema.users.fullName,
    })
    .from(schema.documents)
    /* Left, because the person who raised the quotation may have left the shop
       since, and a document that will not open for that reason is one the shop
       cannot reprint. */
    .leftJoin(schema.users, eq(schema.users.id, schema.documents.createdBy))
    .where(eq(schema.documents.id, id))
  if (!row) return null

  const items = await q(db)
    .select({
      id: schema.documentItems.id,
      productId: schema.documentItems.productId,
      productName: schema.documentItems.productName,
      hsnCode: schema.documentItems.hsnCode,
      taxRateBp: schema.documentItems.taxRateBp,
      saleUnit: schema.documentItems.saleUnit,
      qty: schema.documentItems.qty,
      rate: schema.documentItems.rate,
      discount: schema.documentItems.discount,
      lineTotal: schema.documentItems.lineTotal,
      taxableValue: schema.documentItems.taxableValue,
      cgst: schema.documentItems.cgstAmount,
      sgst: schema.documentItems.sgstAmount,
      igst: schema.documentItems.igstAmount,
      fulfilledQty: schema.documentItems.fulfilledQty,
    })
    .from(schema.documentItems)
    .where(eq(schema.documentItems.documentId, id))
    .orderBy(asc(schema.documentItems.idx))

  const lines = items.map((i) => ({
    ...i,
    remainingQty: Math.max(0, i.qty - i.fulfilledQty) as Qty,
  }))

  const started = lines.filter((l) => l.fulfilledQty > 0).length
  const finished = lines.filter((l) => l.fulfilledQty >= l.qty).length

  return {
    ...row,
    kind: row.kind as DocumentKind,
    /* The column holds a supply type or nothing. Anything else in it is a row
       this code did not write, and the document says nothing rather than
       guessing. */
    supplyType: row.placeOfSupply === 'inter_state' ? 'inter_state'
      : row.placeOfSupply === 'intra_state' ? 'intra_state' : null,
    // The name if the user is still on the books, the id if they are not.
    createdBy: row.createdByName ?? row.createdBy,
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
  const billed = await q(tx)
    .select({
      productId: schema.billItems.productId,
      baseQty: sql<number>`SUM(${schema.billItems.baseQty})`,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, input.billId))
    .groupBy(schema.billItems.productId)
  if (billed.length === 0) return

  const lines = await q(tx)
    .select({
      id: schema.documentItems.id,
      productId: schema.documentItems.productId,
      qty: schema.documentItems.qty,
      baseQty: schema.documentItems.baseQty,
      fulfilledQty: schema.documentItems.fulfilledQty,
    })
    .from(schema.documentItems)
    .where(eq(schema.documentItems.documentId, input.documentId))
    .orderBy(asc(schema.documentItems.idx))
  if (lines.length === 0) return

  const nowIso = input.now.toISOString()
  let marked = 0

  for (const sold of billed) {
    let leftInBase = sold.baseQty

    for (const line of lines) {
      if (leftInBase <= 0) break
      if (line.productId !== sold.productId) continue

      const remaining = line.qty - line.fulfilledQty
      if (remaining <= 0) continue

      const remainingInBase = Math.round((remaining * line.baseQty) / line.qty)
      const takenInBase = Math.min(leftInBase, remainingInBase)
      const taken = Math.min(remaining, Math.round((takenInBase * line.qty) / line.baseQty))
      /* A bill line smaller than one thousandth of an order line's unit rounds
         to nothing here. It is left alone rather than marked off as zero: an
         order that says it is short by an amount nobody can see is still true. */
      if (taken <= 0) continue

      await q(tx).update(schema.documentItems)
        .set({ fulfilledQty: sql`${schema.documentItems.fulfilledQty} + ${taken}` })
        .where(eq(schema.documentItems.id, line.id))

      await q(tx).insert(schema.billFulfilments).values({
        id: newId(),
        billId: input.billId,
        documentId: input.documentId,
        documentItemId: line.id,
        qty: taken as Qty,
        createdAt: nowIso,
      })

      line.fulfilledQty = (line.fulfilledQty + taken) as Qty
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
  const taken = await q(tx)
    .select({
      documentId: schema.billFulfilments.documentId,
      documentItemId: schema.billFulfilments.documentItemId,
      qty: schema.billFulfilments.qty,
    })
    .from(schema.billFulfilments)
    .where(eq(schema.billFulfilments.billId, input.billId))
  if (taken.length === 0) return

  for (const row of taken) {
    /* `MAX(0, ...)` and not a bare subtraction: two cancellations racing, or a
       row put back by hand, must not leave an order claiming a negative
       delivery. */
    await q(tx).update(schema.documentItems)
      .set({ fulfilledQty: sql`MAX(0, ${schema.documentItems.fulfilledQty} - ${row.qty})` })
      .where(eq(schema.documentItems.id, row.documentItemId))
  }
  await q(tx).delete(schema.billFulfilments)
    .where(eq(schema.billFulfilments.billId, input.billId))

  for (const documentId of new Set(taken.map((t) => t.documentId))) {
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
