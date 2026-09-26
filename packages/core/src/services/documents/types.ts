import type { Money } from '../../money.js'
import type { Qty } from '../../quantity.js'

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
