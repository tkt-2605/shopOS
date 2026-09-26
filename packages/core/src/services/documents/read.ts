import { eq, and, or, gte, lte, asc, desc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import type { Qty } from '../../quantity.js'
import type { DocumentKind } from './types.js'

/*
 * Documents as a screen reads them: the filtered list and one in full.
 */

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
export const STARTED = sql<number>`COALESCE(SUM(CASE WHEN ${schema.documentItems.fulfilledQty} > 0 THEN 1 ELSE 0 END), 0)`
export const FINISHED = sql<number>`COALESCE(SUM(CASE WHEN ${schema.documentItems.fulfilledQty} >= ${schema.documentItems.qty} THEN 1 ELSE 0 END), 0)`

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
