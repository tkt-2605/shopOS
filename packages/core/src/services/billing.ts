import type { SqlDriver } from '../db/driver.js'
import { businessDate } from '../dates.js'
import { newId } from '../ids.js'
import { type Money, ZERO, add, sub, formatWithSymbol as formatMoney } from '../money.js'
import { type Qty, qty, QTY_SCALE, negQty } from '../quantity.js'
import { type PriceSource } from '../domain/pricing.js'
import { computeTotals, grossOf, type ComputedTotals } from '../domain/billTotals.js'
import { supplyTypeFor, type SupplyType } from '../domain/tax.js'
import { checkCreditLimit, totalOutstanding, type OpenBill } from '../domain/credit.js'
import { calculateEarned, planRedemption, type LoyaltyProgram, type LoyaltyEntry, DEFAULT_PROGRAM } from '../domain/loyalty.js'
import { DRAFT, SUBMITTED, CANCELLED, assertCanApply, assertAmendable, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { resolveSaleUnit, pricingContextFor, resolveLinePrice } from '../repos/pricing.js'
import { loadStockPolicy } from './features.js'
import { checkAvailability, postMovement, reverseVoucher, type StockShortfall } from './stock.js'
import { nextDocNo } from './numbering.js'
import { openSessionFor, postCashMovement } from './cash.js'
import { getSetting } from './bootstrap.js'

export type PaymentMethod = 'cash' | 'upi' | 'card' | 'credit' | 'loyalty'

export interface BillLineInput {
  productId: string
  saleUnit?: string | null
  qty: Qty
  /** A rate the cashier typed. Recorded as a manual override against their name. */
  rateOverride?: Money | null
  /**
   * A rate already resolved for this line, to be kept rather than resolved again.
   *
   * A bill held open must not re-price itself. Without this, saving a draft
   * re-runs the whole resolution chain, so a bill parked past a price list's
   * `valid_to` silently changes what the customer was quoted.
   */
  resolved?: { rate: Money; source: PriceSource; sourceId: string | null } | null
  discount?: Money
}

export interface CreateBillInput {
  registerId: string
  sessionId?: string | null
  customerId?: string | null
  lines: BillLineInput[]
  billDiscount?: Money
  postingDate?: string
  notes?: string
  actorId: string
  now?: Date
}

export interface PaymentInput {
  method: PaymentMethod
  amount: Money
  reference?: string
}

export interface SubmitBillInput {
  billId: string
  payments: PaymentInput[]
  redeemPoints?: number
  idempotencyKey?: string
  actorId: string
  now?: Date
}

export interface BillTotals {
  subtotal: Money
  discount: Money
  taxableTotal: Money
  taxTotal: Money
  grandTotal: Money
}

export type CreateBillResult =
  | ({ ok: true; billId: string; docNo: string; lineCount: number } & BillTotals)
  | { ok: false; code: 'NO_LINES' }
  | { ok: false; code: 'UNKNOWN_PRODUCT'; productId: string }
  | { ok: false; code: 'INVALID_QTY'; productId: string }
  | { ok: false; code: 'DISCOUNT_EXCEEDS_TOTAL'; subtotal: Money; discount: Money }
  | { ok: false; code: 'DISCOUNT_BLOCKED'; productId: string; productName: string }

export type SubmitBillResult =
  | {
      ok: true; billId: string; docNo: string; grandTotal: Money
      pointsEarned: number; pointsRedeemed: number; idempotent: boolean
      /**
       * Lines that were sold with nothing on the shelf. Empty on an ordinary
       * sale. Present so the counter can say what it just did and the shop can
       * find the item again on the shortfall report — never a refusal, or the
       * setting would mean nothing.
       */
      shortfalls: StockShortfall[]
    }
  | { ok: false; code: 'INSUFFICIENT_STOCK'; shortfalls: StockShortfall[] }
  | { ok: false; code: 'CREDIT_LIMIT_EXCEEDED'; limit: Money; projected: Money; excess: Money }
  | { ok: false; code: 'PAYMENT_MISMATCH'; expected: Money; received: Money }
  | { ok: false; code: 'CREDIT_WITHOUT_CUSTOMER' }
  | { ok: false; code: 'LOYALTY_REJECTED'; reason: string }

export type CancelBillResult =
  | { ok: true; billId: string }
  | { ok: false; code: 'HAS_RETURNS'; returnCount: number }
  | { ok: false; code: 'HAS_PAYMENTS'; paymentCount: number }

interface ComputedLine {
  productId: string
  productName: string
  hsnCode: string | null
  saleUnit: string
  qty: Qty
  baseQty: Qty
  rate: Money
  mrp: Money | null
  discount: Money
  taxRateBp: number
  priceSource: PriceSource
  priceSourceId: string | null
  /** Copied onto the line as it stood at the time of sale, so a bill stays explainable. */
  discountBlocked: boolean
  loyaltyBlocked: boolean
}

/**
 * Everything a bill needs worked out, and nothing written. Both the first save and
 * every later one go through here, so a held bill cannot drift away from a fresh
 * one — prices, units and tax are resolved by the same code either way.
 */
type Priced =
  | { ok: true; computed: ComputedLine[]; totals: ComputedTotals; meta: DraftMeta; subtotal: Money }
  | Exclude<CreateBillResult, { ok: true }>

interface DraftMeta {
  sessionId: string | null
  customerId: string | null
  customerName: string | null
  postingDate: string
  placeOfSupply: string | null
  billDiscount: Money
  notes: string | null
  supply: SupplyType
  now: Date
}

async function priceBill(db: SqlDriver, input: CreateBillInput): Promise<Priced> {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }

  const now = input.now ?? new Date()
  const postingDate = input.postingDate ?? businessDate(now)

  const sessionId = input.sessionId ?? (await openSessionFor(db, input.registerId))
  const customer = input.customerId ? await loadCustomer(db, input.customerId) : null
  const supply = await supplyFor(db, customer?.stateCode ?? null)
  const pricing = await pricingContextFor(db, input.customerId ?? null)

  const computed: ComputedLine[] = []
  for (const line of input.lines) {
    if (line.qty <= 0) return { ok: false, code: 'INVALID_QTY', productId: line.productId }

    const product = await db.get<{
      id: string; name: string; hsn_code: string | null; tax_rate_bp: number; mrp: number | null
      discount_blocked: number; loyalty_blocked: number
    }>(
      `SELECT id, name, hsn_code, tax_rate_bp, mrp, discount_blocked, loyalty_blocked
         FROM products WHERE id = ? AND deleted_at IS NULL`,
      [line.productId],
    )
    if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT', productId: line.productId }

    const discountBlocked = product.discount_blocked === 1
    const loyaltyBlocked = product.loyalty_blocked === 1

    const unit = await resolveSaleUnit(db, line.productId, line.saleUnit ?? null)

    // A typed rate wins, then a rate already resolved for this line, and only a
    // line with neither is priced from scratch.
    const priced = line.rateOverride != null
      ? { rate: line.rateOverride, source: 'manual_override' as PriceSource, sourceId: null }
      : line.resolved
        ? line.resolved
        : await resolveLinePrice(db, pricing, { productId: line.productId, saleUnit: unit.saleUnit, qty: line.qty }, now)

    const discount = line.discount ?? ZERO
    // Refused rather than quietly dropped: a cashier who types a discount on a
    // razor-margin line should be told it will not be given, not left believing
    // it was.
    if (discountBlocked && discount > 0) {
      return { ok: false, code: 'DISCOUNT_BLOCKED', productId: product.id, productName: product.name }
    }
    if (sub(grossOf(priced.rate, line.qty), discount) < 0) {
      return { ok: false, code: 'DISCOUNT_EXCEEDS_TOTAL', subtotal: grossOf(priced.rate, line.qty), discount }
    }

    computed.push({
      productId: product.id,
      productName: product.name,
      hsnCode: product.hsn_code,
      saleUnit: unit.saleUnit,
      qty: line.qty,
      baseQty: qty(Math.round((line.qty * unit.baseUnits) / QTY_SCALE)),
      rate: priced.rate,
      mrp: (product.mrp ?? null) as Money | null,
      discount,
      taxRateBp: product.tax_rate_bp,
      priceSource: priced.source,
      priceSourceId: priced.sourceId,
      discountBlocked,
      loyaltyBlocked,
    })
  }

  const billDiscount = input.billDiscount ?? ZERO
  const totals = computeTotals(computed, billDiscount, supply)

  // computeTotals clamps for the screen's benefit; a service caller asking for
  // more discount than the bill holds is a mistake worth reporting, not silently
  // reducing. The comparison is against the discountable part, because a bill
  // whose lines are all excluded can carry no bill discount at all.
  if (billDiscount > totals.discountableSubtotal) {
    return {
      ok: false,
      code: 'DISCOUNT_EXCEEDS_TOTAL',
      subtotal: totals.discountableSubtotal,
      discount: billDiscount,
    }
  }

  return {
    ok: true,
    computed,
    totals,
    subtotal: totals.subtotal,
    meta: {
      sessionId,
      customerId: input.customerId ?? null,
      customerName: customer?.name ?? null,
      postingDate,
      placeOfSupply: customer?.stateCode ?? null,
      billDiscount,
      notes: input.notes ?? null,
      supply,
      now,
    },
  }
}

/**
 * Writes the line rows against figures already computed. `bill_items.discount`
 * holds the line's own discount plus its share of the bill-level one, and
 * `line_total` is already net, so the rows reconcile to the invoice total exactly.
 */
async function writeLines(
  tx: SqlDriver,
  billId: string,
  computed: ComputedLine[],
  totals: ComputedTotals,
): Promise<void> {
  for (const [i, line] of computed.entries()) {
    const t = totals.lines[i]!

    await tx.execute(
      `INSERT INTO bill_items
         (id, bill_id, idx, product_id, product_name, hsn_code, sale_unit, qty, base_qty, rate, mrp,
          discount, line_total, taxable_value, tax_rate_bp, cgst_amount, sgst_amount, igst_amount,
          price_source, price_source_id, discount_blocked, loyalty_blocked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(), billId, i + 1, line.productId, line.productName, line.hsnCode, line.saleUnit,
        line.qty, line.baseQty, line.rate, line.mrp,
        add(line.discount, t.billDiscountShare), t.net,
        t.tax.taxableValue, line.taxRateBp, t.tax.cgst, t.tax.sgst, t.tax.igst,
        line.priceSource, line.priceSourceId,
        line.discountBlocked ? 1 : 0, line.loyaltyBlocked ? 1 : 0,
      ],
    )
  }
}

export async function createBill(db: SqlDriver, input: CreateBillInput): Promise<CreateBillResult> {
  const priced = await priceBill(db, input)
  if (!priced.ok) return priced

  const { computed, totals, meta, subtotal } = priced
  const billId = newId()
  const nowIso = meta.now.toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO bills
         (id, doc_no, docstatus, register_id, session_id, customer_id, customer_name, posting_date,
          subtotal, discount, taxable_total, tax_total, grand_total, place_of_supply, notes,
          created_by, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
      [
        billId, `DRAFT-${billId}`, input.registerId, meta.sessionId,
        meta.customerId, meta.customerName, meta.postingDate,
        meta.billDiscount, meta.placeOfSupply, meta.notes,
        input.actorId, nowIso, nowIso,
      ],
    )

    await writeLines(tx, billId, computed, totals)

    await tx.execute(
      `UPDATE bills SET subtotal = ?, taxable_total = ?, tax_total = ?, grand_total = ? WHERE id = ?`,
      [subtotal, totals.taxableTotal, totals.taxTotal, totals.grandTotal, billId],
    )

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: billId, action: 'create', docstatusTo: DRAFT,
    })
  })

  return {
    ok: true,
    billId,
    docNo: `DRAFT-${billId}`,
    lineCount: computed.length,
    subtotal,
    discount: totals.discount,
    taxableTotal: totals.taxableTotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
  }
}

export type SaveDraftResult = CreateBillResult | { ok: false; code: 'NOT_A_DRAFT' }

/**
 * Replaces a draft's contents in place. The counter calls this as the cashier works,
 * so an interrupted bill survives switching screens, a crash, or the power going out —
 * and so a bill can be held while somebody else is served.
 *
 * Lines are rewritten wholesale rather than diffed: a draft has no ledger effect, so
 * there is nothing a diff would protect and a great deal it could get wrong.
 */
export async function saveDraft(
  db: SqlDriver,
  input: CreateBillInput & { billId: string },
): Promise<SaveDraftResult> {
  const existing = await db.get<{ docstatus: number }>(
    `SELECT docstatus FROM bills WHERE id = ?`, [input.billId],
  )
  if (!existing || existing.docstatus !== DRAFT) return { ok: false, code: 'NOT_A_DRAFT' }

  const priced = await priceBill(db, input)
  if (!priced.ok) return priced

  const { computed, totals, meta, subtotal } = priced

  await db.transaction(async (tx) => {
    await tx.execute(`DELETE FROM bill_items WHERE bill_id = ?`, [input.billId])
    await writeLines(tx, input.billId, computed, totals)

    await tx.execute(
      `UPDATE bills SET session_id = ?, customer_id = ?, customer_name = ?, posting_date = ?,
              subtotal = ?, discount = ?, taxable_total = ?, tax_total = ?, grand_total = ?,
              place_of_supply = ?, notes = ?, updated_at = ?
         WHERE id = ? AND docstatus = 0`,
      [
        meta.sessionId, meta.customerId, meta.customerName, meta.postingDate,
        subtotal, totals.discount, totals.taxableTotal, totals.taxTotal, totals.grandTotal,
        meta.placeOfSupply, meta.notes, meta.now.toISOString(), input.billId,
      ],
    )
  })

  return {
    ok: true,
    billId: input.billId,
    docNo: `DRAFT-${input.billId}`,
    lineCount: computed.length,
    subtotal,
    discount: totals.discount,
    taxableTotal: totals.taxableTotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
  }
}

export async function submitBill(db: SqlDriver, input: SubmitBillInput): Promise<SubmitBillResult> {
  const now = input.now ?? new Date()

  if (input.idempotencyKey) {
    const existing = await db.get<{ id: string; doc_no: string; grand_total: number }>(
      `SELECT id, doc_no, grand_total FROM bills WHERE idempotency_key = ?`,
      [input.idempotencyKey],
    )
    if (existing) {
      return {
        ok: true, billId: existing.id, docNo: existing.doc_no,
        grandTotal: existing.grand_total as Money,
        // A replay reports nothing new: whatever was short was said at the time.
        pointsEarned: 0, pointsRedeemed: 0, idempotent: true, shortfalls: [],
      }
    }
  }

  const bill = await loadBill(db, input.billId)
  assertCanApply('bill', parseDocStatus(bill.docstatus), 'submit')

  const lines = await db.query<{
    product_id: string; product_name: string; base_qty: number
    line_total: number; loyalty_blocked: number
  }>(
    `SELECT product_id, product_name, base_qty, line_total, loyalty_blocked
       FROM bill_items WHERE bill_id = ? ORDER BY idx`,
    [input.billId],
  )

  const program = await loadLoyaltyProgram(db)
  let pointsRedeemed = 0
  let redemptionValue: Money = ZERO
  let redemptionPlan: { entryId: string; points: number }[] = []

  if (input.redeemPoints && input.redeemPoints > 0) {
    if (!bill.customerId) return { ok: false, code: 'LOYALTY_REJECTED', reason: 'no customer on the bill' }
    const entries = await loadLoyaltyEntries(db, bill.customerId)
    const plan = planRedemption(program, entries, input.redeemPoints, bill.grandTotal, now)
    if (!plan.ok) return { ok: false, code: 'LOYALTY_REJECTED', reason: plan.code }
    pointsRedeemed = plan.points
    redemptionValue = plan.value
    redemptionPlan = plan.allocations
  }

  const received = add(...input.payments.map((p) => p.amount), redemptionValue)
  if (received !== bill.grandTotal) {
    return { ok: false, code: 'PAYMENT_MISMATCH', expected: bill.grandTotal, received }
  }

  const creditTotal = add(...input.payments.filter((p) => p.method === 'credit').map((p) => p.amount))
  if (creditTotal > 0 && !bill.customerId) return { ok: false, code: 'CREDIT_WITHOUT_CUSTOMER' }

  if (creditTotal > 0 && bill.customerId) {
    const customer = await loadCustomer(db, bill.customerId)
    const outstanding = totalOutstanding(await loadOpenBills(db, bill.customerId))
    const check = checkCreditLimit({
      creditLimit: customer.creditLimit,
      enforcement: customer.creditEnforcement,
      currentOutstanding: outstanding,
      additionalCredit: creditTotal,
    })
    if (!check.allowed) {
      return { ok: false, code: 'CREDIT_LIMIT_EXCEEDED', limit: check.limit, projected: check.projected, excess: check.excess }
    }
  }

  const requirements = lines.map((l) => ({
    productId: l.product_id,
    productName: l.product_name,
    required: qty(l.base_qty),
  }))
  /* The check is the same as it always was; what changed is who it binds.
     Under `block` a short line still refuses the sale. Otherwise the sale goes
     through and the shortfall is reported back on the result, so the counter can
     say what happened and the shortfall report can pick it up afterwards. */
  const shortfalls = await checkAvailability(db, requirements)
  if (shortfalls.length > 0 && await loadStockPolicy(db) === 'block') {
    return { ok: false, code: 'INSUFFICIENT_STOCK', shortfalls }
  }

  // Read off the line's own flag rather than the product's, so a bill earns on
  // the rules that were in force when it was rung up.
  const earningTotal = add(
    ...lines.filter((l) => l.loyalty_blocked !== 1).map((l) => l.line_total as Money),
  )
  const earned = calculateEarned(
    program,
    { grandTotal: bill.grandTotal, creditPortion: creditTotal, earningTotal },
    now,
  )
  const register = await db.get<{ prefix: string }>(`SELECT prefix FROM registers WHERE id = ?`, [bill.registerId])
  const nowIso = now.toISOString()
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'bill', register?.prefix ?? 'XX', now)

    for (const line of lines) {
      await postMovement(tx, {
        productId: line.product_id,
        qtyChange: negQty(qty(line.base_qty)),
        voucherType: 'bill',
        voucherId: input.billId,
        postingDate: bill.postingDate,
        userId: input.actorId,
      })
    }

    for (const payment of input.payments) {
      await tx.execute(
        `INSERT INTO bill_payments (id, bill_id, method, amount, reference) VALUES (?, ?, ?, ?, ?)`,
        [newId(), input.billId, payment.method, payment.amount, payment.reference ?? null],
      )
      // Credit moves no money today and loyalty never does.
      if (bill.sessionId && payment.method !== 'credit') {
        await postCashMovement(tx, {
          sessionId: bill.sessionId,
          direction: 'in',
          amount: payment.amount,
          method: payment.method,
          sourceType: 'bill',
          sourceId: input.billId,
          reference: payment.reference ?? null,
          userId: input.actorId,
          now,
        })
      }
    }

    if (redemptionValue > 0) {
      await tx.execute(
        `INSERT INTO bill_payments (id, bill_id, method, amount, reference) VALUES (?, ?, 'loyalty', ?, ?)`,
        [newId(), input.billId, redemptionValue, `${pointsRedeemed} points`],
      )
    }

    for (const alloc of redemptionPlan) {
      await tx.execute(`UPDATE loyalty_entries SET consumed = consumed + ? WHERE id = ?`, [alloc.points, alloc.entryId])
      await tx.execute(
        `INSERT INTO loyalty_redemptions (id, customer_id, bill_id, loyalty_entry_id, points, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), bill.customerId, input.billId, alloc.entryId, alloc.points, nowIso],
      )
    }

    if (earned.points > 0 && bill.customerId) {
      await tx.execute(
        `INSERT INTO loyalty_entries (id, customer_id, bill_id, points, earned_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId(), bill.customerId, input.billId, earned.points, nowIso, earned.expiresAt, nowIso],
      )
    }

    await tx.execute(
      `UPDATE bills
          SET docstatus = 1, doc_no = ?, paid_total = ?, credit_total = ?, idempotency_key = ?, updated_at = ?
        WHERE id = ?`,
      [docNo, sub(bill.grandTotal, creditTotal), creditTotal, input.idempotencyKey ?? null, nowIso, input.billId],
    )

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: input.billId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      before: { doc_no: bill.docNo }, after: { doc_no: docNo },
    })
  })

  return {
    ok: true,
    billId: input.billId,
    docNo,
    grandTotal: bill.grandTotal,
    pointsEarned: earned.points,
    pointsRedeemed,
    idempotent: false,
    shortfalls,
  }
}

export async function cancelBill(
  db: SqlDriver,
  input: { billId: string; reason?: string; actorId: string; now?: Date },
): Promise<CancelBillResult> {
  const now = input.now ?? new Date()
  const bill = await loadBill(db, input.billId)
  assertCanApply('bill', parseDocStatus(bill.docstatus), 'cancel')

  const returns = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sales_returns WHERE bill_id = ? AND docstatus = 1`,
    [input.billId],
  )
  if ((returns?.n ?? 0) > 0) return { ok: false, code: 'HAS_RETURNS', returnCount: returns!.n }

  const allocations = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM payment_allocations pa
       JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
      WHERE pa.bill_id = ?`,
    [input.billId],
  )
  if ((allocations?.n ?? 0) > 0) return { ok: false, code: 'HAS_PAYMENTS', paymentCount: allocations!.n }

  const nowIso = now.toISOString()

  const tenders = await db.query<{ method: string; amount: number }>(
    `SELECT method, amount FROM bill_payments WHERE bill_id = ? AND method <> 'credit'`,
    [input.billId],
  )

  await db.transaction(async (tx) => {
    await reverseVoucher(tx, 'bill', input.billId, bill.postingDate, input.actorId)

    const session = await openSessionFor(tx, bill.registerId)
    if (session) {
      for (const tender of tenders) {
        await postCashMovement(tx, {
          sessionId: session,
          direction: 'out',
          amount: tender.amount as Money,
          method: tender.method as 'cash' | 'upi' | 'card' | 'loyalty',
          sourceType: 'bill_cancel',
          sourceId: input.billId,
          userId: input.actorId,
          now,
        })
      }
    }

    // Only the part still outstanding. A return against this bill may already
    // have handed some of these points back, and taking them off `consumed` a
    // second time would invent points the customer never had.
    const redemptions = await tx.query<{ id: string; loyalty_entry_id: string; owed: number }>(
      `SELECT id, loyalty_entry_id, points - restored AS owed FROM loyalty_redemptions
        WHERE bill_id = ? AND reversed_at IS NULL`,
      [input.billId],
    )
    for (const r of redemptions) {
      if (r.owed > 0) {
        await tx.execute(`UPDATE loyalty_entries SET consumed = consumed - ? WHERE id = ?`, [r.owed, r.loyalty_entry_id])
      }
      await tx.execute(`UPDATE loyalty_redemptions SET reversed_at = ? WHERE id = ?`, [nowIso, r.id])
    }

    await tx.execute(
      `UPDATE loyalty_entries SET cancelled_at = ? WHERE bill_id = ? AND cancelled_at IS NULL`,
      [nowIso, input.billId],
    )

    await tx.execute(
      `UPDATE bills SET docstatus = 2, cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?`,
      [input.actorId, nowIso, input.reason ?? null, nowIso, input.billId],
    )

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: input.billId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, billId: input.billId }
}

/**
 * Amend copies a cancelled bill into a fresh draft. It does not resurrect the
 * original — the cancelled document stays on the record with the new one linked
 * to it, which is what makes "edit a bill" auditable.
 */
export async function amendBill(
  db: SqlDriver,
  input: { billId: string; actorId: string; now?: Date },
): Promise<CreateBillResult> {
  const source = await loadBill(db, input.billId)
  assertAmendable('bill', parseDocStatus(source.docstatus))

  const lines = await db.query<{ product_id: string; sale_unit: string; qty: number; rate: number; discount: number }>(
    `SELECT product_id, sale_unit, qty, rate, discount FROM bill_items WHERE bill_id = ? ORDER BY idx`,
    [input.billId],
  )

  const created = await createBill(db, {
    registerId: source.registerId,
    customerId: source.customerId,
    lines: lines.map((l) => ({
      productId: l.product_id,
      saleUnit: l.sale_unit,
      qty: qty(l.qty),
      rateOverride: l.rate as Money,
    })),
    actorId: input.actorId,
    ...(input.now ? { now: input.now } : {}),
  })

  if (!created.ok) return created

  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE bills SET amended_from = ? WHERE id = ?`, [input.billId, created.billId])
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: created.billId, action: 'amend',
      after: { amended_from: input.billId },
    })
  })

  return created
}

interface BillRow {
  id: string
  docNo: string
  docstatus: number
  registerId: string
  sessionId: string | null
  customerId: string | null
  postingDate: string
  grandTotal: Money
}

async function loadBill(db: SqlDriver, billId: string): Promise<BillRow> {
  const row = await db.get<{
    id: string; doc_no: string; docstatus: number; register_id: string; session_id: string | null
    customer_id: string | null; posting_date: string; grand_total: number
  }>(
    `SELECT id, doc_no, docstatus, register_id, session_id, customer_id, posting_date, grand_total FROM bills WHERE id = ?`,
    [billId],
  )
  if (!row) throw new Error(`unknown bill: ${billId}`)
  return {
    id: row.id,
    docNo: row.doc_no,
    docstatus: row.docstatus,
    registerId: row.register_id,
    sessionId: row.session_id,
    customerId: row.customer_id,
    postingDate: row.posting_date,
    grandTotal: row.grand_total as Money,
  }
}

interface CustomerRow {
  id: string
  name: string
  stateCode: string | null
  priceListId: string | null
  creditLimit: Money
  creditEnforcement: 'none' | 'soft' | 'hard'
}

async function loadCustomer(db: SqlDriver, customerId: string): Promise<CustomerRow> {
  const row = await db.get<{
    id: string; name: string; state_code: string | null; price_list_id: string | null
    credit_limit: number; credit_enforcement: string
  }>(
    `SELECT id, name, state_code, price_list_id, credit_limit, credit_enforcement FROM customers WHERE id = ?`,
    [customerId],
  )
  if (!row) throw new Error(`unknown customer: ${customerId}`)
  return {
    id: row.id,
    name: row.name,
    stateCode: row.state_code,
    priceListId: row.price_list_id,
    creditLimit: row.credit_limit as Money,
    creditEnforcement: row.credit_enforcement as 'none' | 'soft' | 'hard',
  }
}

async function loadOpenBills(db: SqlDriver, customerId: string): Promise<OpenBill[]> {
  const rows = await db.query<{ id: string; doc_no: string; posting_date: string; credit_total: number; allocated: number }>(
    `SELECT b.id, b.doc_no, b.posting_date, b.credit_total,
            COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                        JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                       WHERE pa.bill_id = b.id), 0) AS allocated
       FROM bills b
      WHERE b.customer_id = ? AND b.docstatus = 1 AND b.credit_total > 0`,
    [customerId],
  )
  return rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    postingDate: r.posting_date,
    creditTotal: r.credit_total as Money,
    allocated: r.allocated as Money,
  }))
}

async function loadLoyaltyEntries(db: SqlDriver, customerId: string): Promise<LoyaltyEntry[]> {
  const rows = await db.query<{
    id: string; points: number; consumed: number; earned_at: string
    expires_at: string | null; cancelled_at: string | null
  }>(
    `SELECT id, points, consumed, earned_at, expires_at, cancelled_at FROM loyalty_entries WHERE customer_id = ?`,
    [customerId],
  )
  return rows.map((r) => ({
    id: r.id,
    points: r.points,
    consumed: r.consumed,
    earnedAt: r.earned_at,
    expiresAt: r.expires_at,
    cancelledAt: r.cancelled_at,
  }))
}

export async function loadLoyaltyProgram(db: SqlDriver): Promise<LoyaltyProgram> {
  const raw = await getSetting(db, 'loyalty_program')
  if (!raw) return DEFAULT_PROGRAM
  try {
    return { ...DEFAULT_PROGRAM, ...(JSON.parse(raw) as Partial<LoyaltyProgram>) }
  } catch {
    return DEFAULT_PROGRAM
  }
}

async function supplyFor(db: SqlDriver, customerStateCode: string | null): Promise<SupplyType> {
  const shopState = await getSetting(db, 'shop_state_code')
  return supplyTypeFor(shopState, customerStateCode)
}

export function billSummary(totals: BillTotals, lineCount: number): string {
  return `${lineCount} item${lineCount === 1 ? '' : 's'}, ${formatMoney(totals.grandTotal)}`
}
