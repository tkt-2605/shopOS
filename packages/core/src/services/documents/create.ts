import { eq, and, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import { businessDate } from '../../dates.js'
import { ZERO, type Money } from '../../money.js'
import { QTY_SCALE, qty as asQty, type Qty } from '../../quantity.js'
import { computeTotals } from '../../domain/billTotals.js'
import { loadRounding, loadTaxScheme } from '../features.js'
import { chargesTax } from '../../domain/taxScheme.js'
import { DRAFT } from '../../integrity/docstatus.js'
import { resolveSaleUnit, pricingContextFor, resolveLinePrice, purchaseOrderRate } from '../../repos/pricing.js'
import { nextDocNo, seriesPrefix } from '../numbering.js'
import { writeAudit } from '../../integrity/audit.js'
import type { CreateDocumentInput, CreateDocumentResult } from './types.js'
import { supplyFor } from '../billing/load.js'
import { requirePermission } from '../../integrity/permissions.js'

export async function createDocument(
  db: SqlDriver,
  input: CreateDocumentInput,
): Promise<CreateDocumentResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  const now = input.now ?? new Date()
  const p = await priceDocument(db, input, now)
  if (!p.ok) return p
  const { priced, totals, party, forSupplier } = p
  const nowIso = now.toISOString()
  const postingDate = input.postingDate ?? businessDate(now)
  const documentId = newId()
  let docNo = ''

  await db.transaction(async (tx) => {
    const [register] = await q(tx)
      .select({ prefix: schema.registers.prefix })
      .from(schema.registers)
      .where(eq(schema.registers.id, input.registerId))
    docNo = await nextDocNo(tx, input.kind, register?.prefix ?? await seriesPrefix(tx, 'MR'), now)

    await q(tx).insert(schema.documents).values({
      id: documentId,
      docNo,
      kind: input.kind,
      docstatus: DRAFT,
      registerId: input.registerId,
      ...partyColumns(forSupplier, input, party),
      postingDate,
      validUntil: input.validUntil ?? null,
      ...totalsColumns(totals),
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      convertedFrom: input.convertedFrom ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    await writeDocumentLines(tx, documentId, priced, totals)

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

/** The party, the priced lines and the totals a document's input comes to -- for a new one and an edited draft alike. */
export type PricedDocument =
  | {
      ok: true; priced: PricedLine[]; totals: ReturnType<typeof computeTotals>
      party: { name: string; stateCode: string | null } | undefined; forSupplier: boolean
    }
  | Extract<CreateDocumentResult, { ok: false }>

export async function priceDocument(
  db: SqlDriver,
  input: Pick<CreateDocumentInput, 'kind' | 'customerId' | 'supplierId' | 'lines'>,
  now: Date,
): Promise<PricedDocument> {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }

  /* A purchase order with no supplier is an order placed with nobody, and a
     quotation with no customer cannot be handed to anyone. Both are refused
     here rather than stored as a document that can never be acted on. */
  const forSupplier = input.kind === 'purchase_order'
  if (forSupplier && !input.supplierId) return { ok: false, code: 'PARTY_REQUIRED' }
  if (!forSupplier && !input.customerId) return { ok: false, code: 'PARTY_REQUIRED' }

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
  /* A quotation says what the bill will say, so it charges tax on the same
     terms: nothing, for a composition dealer or an unregistered shop -- see
     `priceBill`. Only on what the shop sells. A purchase order is the supplier's
     tax, which the shop pays whatever scheme it is on. */
  const taxed = forSupplier || chargesTax(await loadTaxScheme(db))
  const priced: PricedLine[] = []
  for (const line of input.lines) {
    if (line.qty <= 0) return { ok: false, code: 'INVALID_QTY', productId: line.productId }

    const [product] = await q(db)
      .select({
        id: schema.products.id,
        name: schema.products.name,
        hsnCode: schema.products.hsnCode,
        taxRateBp: schema.products.taxRateBp,
        cessRateBp: schema.products.cessRateBp,
        discountBlocked: schema.products.discountBlocked,
      })
      .from(schema.products)
      .where(and(eq(schema.products.id, line.productId), isNull(schema.products.deletedAt)))
    if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT', productId: line.productId }

    const unit = await resolveSaleUnit(db, line.productId, line.saleUnit ?? null)
    const resolved = line.rateOverride != null
      ? { rate: line.rateOverride, includesTax: line.rateIncludesTax ?? !forSupplier }
      : forSupplier
        ? await purchaseOrderRate(db, line.productId, unit.baseUnits)
        : await resolveLinePrice(
          db, pricing, { productId: line.productId, saleUnit: unit.saleUnit, qty: line.qty }, now,
        )

    priced.push({
      productId: product.id,
      productName: product.name,
      hsnCode: product.hsnCode,
      saleUnit: unit.saleUnit,
      qty: line.qty,
      baseQty: asQty(Math.round((line.qty * unit.baseUnits) / QTY_SCALE)),
      rate: resolved.rate,
      discount: line.discount ?? ZERO,
      taxRateBp: taxed ? product.taxRateBp : 0,
      cessRateBp: taxed ? product.cessRateBp : 0,
      rateIncludesTax: resolved.includesTax,
      discountBlocked: product.discountBlocked === 1,
    })
  }

  /* Rounded by the shop's own rule, like a bill. A quotation for ₹99.60 that
     becomes a bill for ₹100 has quoted the wrong number, and the difference is
     the one a customer notices. */
  const totals = computeTotals(priced, ZERO, supply, await loadRounding(db))
  return { ok: true, priced, totals, party, forSupplier }
}

/** Who the document is to, in the columns both kinds of party use. */
export function partyColumns(
  forSupplier: boolean,
  input: Pick<CreateDocumentInput, 'customerId' | 'supplierId'>,
  party: { name: string; stateCode: string | null } | undefined,
) {
  return {
    customerId: forSupplier ? null : input.customerId ?? null,
    customerName: forSupplier ? null : party?.name ?? null,
    supplierId: forSupplier ? input.supplierId ?? null : null,
    supplierName: forSupplier ? party?.name ?? null : null,
    // A state code, as on a bill -- not the supply type, which is derived from it.
    placeOfSupply: forSupplier ? null : party?.stateCode ?? null,
  }
}

export function totalsColumns(totals: ReturnType<typeof computeTotals>) {
  return {
    subtotal: totals.subtotal,
    discount: totals.discount,
    taxableTotal: totals.taxableTotal,
    taxTotal: totals.taxTotal,
    roundOff: totals.roundOff,
    grandTotal: totals.grandTotal,
  }
}

/** A document's lines, written in order. The caller has removed any it had. */
export async function writeDocumentLines(
  tx: SqlDriver, documentId: string, priced: readonly PricedLine[], totals: ReturnType<typeof computeTotals>,
): Promise<void> {
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
      /* What the line comes to with its tax, as on a bill. The same figure as
         before for a shelf price, which is every line written before 063. */
      lineTotal: computed.net,
      taxableValue: computed.tax.taxableValue,
      taxRateBp: line.taxRateBp,
      cgstAmount: computed.tax.cgst,
      sgstAmount: computed.tax.sgst,
      igstAmount: computed.tax.igst,
      cessRateBp: line.cessRateBp,
      cessAmount: computed.tax.cess,
      rateIncludesTax: line.rateIncludesTax ? 1 : 0,
    })
  }
}

export interface PricedLine {
  productId: string
  productName: string
  hsnCode: string | null
  saleUnit: string
  qty: Qty
  baseQty: Qty
  rate: Money
  discount: Money
  taxRateBp: number
  cessRateBp: number
  rateIncludesTax: boolean
  discountBlocked: boolean
}

