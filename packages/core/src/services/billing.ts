import { eq, and, ne, gt, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
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
import { loadStockPolicy, loadRounding, loadTaxScheme } from './features.js'
import { chargesTax } from '../domain/taxScheme.js'
import { isStateCode } from '../domain/states.js'
import { checkAvailability, postMovement, reverseVoucher, type StockShortfall } from './stock.js'
import { nextDocNo } from './numbering.js'
import { openSessionFor, postCashMovement } from './cash.js'
import { applyBillFulfilment, reverseBillFulfilment } from './documents.js'
import { getSetting } from './bootstrap.js'

/**
 * Rule 46(f)'s threshold, in paise: fifty thousand rupees.
 *
 * Written once, here, because the counter has to warn at the same figure the
 * service refuses at -- a cashier told at ₹50,000 and refused at ₹49,999 would
 * stop trusting either number.
 */
export const RULE_46F_THRESHOLD = 5_000_000 as Money

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
  /**
   * The sales order or quotation this bill is fulfilling.
   *
   * Carried on the draft from the moment the cart is loaded, so that it
   * survives the power going out the way the rest of the draft does — and so
   * that the order is marked off by the payment rather than by the loading.
   * Nothing happens to the order until `submitBill`.
   */
  convertedFrom?: string | null
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
  /**
   * The shop has not said which state it is in, and it charges tax.
   *
   * `supplyTypeFor(null, anything)` answers `intra_state`, so with no shop
   * state every sale in the product is taxed as a local one -- CGST and SGST --
   * including a sale to a customer in another state, where the law says IGST.
   * The bill is wrong, the customer's input credit is wrong, and nothing on
   * screen says so. It is refused at submit rather than corrected silently,
   * because there is no honest value to correct it to.
   *
   * One setting, on a screen the shop has already seen, and it is asked for at
   * first run. A till that has been billing has it.
   */
  | { ok: false; code: 'SHOP_STATE_UNSET' }
  /**
   * Rule 46(f): a tax invoice of ₹50,000 or more to somebody not registered
   * must carry their name and address.
   *
   * A required field rather than a stopped till -- the counter puts a name on
   * the bill and carries on. Only under the regular scheme, because it is that
   * rule and no other: Rule 49's bill of supply carries no such threshold, and
   * a guard with no rule behind it is a guard that stops a shop for nothing.
   */
  | { ok: false; code: 'NEEDS_RECIPIENT'; grandTotal: Money; threshold: Money }

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

  /* A composition dealer may not collect tax on supplies at all (Section 10,
     Rule 49) and an unregistered shop has none to collect. Until now this
     product charged CGST and SGST on every line whatever the shop was, and
     handed the customer a document headed "Tax Invoice" to prove it.

     The rate is zeroed on the *line*, not on the product: the product's rate is
     a fact about the goods and has to survive the day the shop registers,
     whereas `bill_items.tax_rate_bp` is what this bill charged -- which was
     nothing. Everything downstream then follows without knowing the scheme
     exists: `splitTax` at 0 makes the taxable value the line total, the GST
     export reports a 0% row, and a return reverses nothing. */
  const taxed = chargesTax(await loadTaxScheme(db))
  const pricing = await pricingContextFor(db, input.customerId ?? null)

  const computed: ComputedLine[] = []
  for (const line of input.lines) {
    if (line.qty <= 0) return { ok: false, code: 'INVALID_QTY', productId: line.productId }

    const [product] = await q(db)
      .select({
        id: schema.products.id,
        name: schema.products.name,
        hsnCode: schema.products.hsnCode,
        taxRateBp: schema.products.taxRateBp,
        mrp: schema.products.mrp,
        discountBlocked: schema.products.discountBlocked,
        loyaltyBlocked: schema.products.loyaltyBlocked,
      })
      .from(schema.products)
      .where(and(eq(schema.products.id, line.productId), isNull(schema.products.deletedAt)))
    if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT', productId: line.productId }

    const discountBlocked = product.discountBlocked === 1
    const loyaltyBlocked = product.loyaltyBlocked === 1

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
      hsnCode: product.hsnCode,
      saleUnit: unit.saleUnit,
      qty: line.qty,
      baseQty: qty(Math.round((line.qty * unit.baseUnits) / QTY_SCALE)),
      rate: priced.rate,
      mrp: product.mrp ?? null,
      discount,
      taxRateBp: taxed ? product.taxRateBp : 0,
      priceSource: priced.source,
      priceSourceId: priced.sourceId,
      discountBlocked,
      loyaltyBlocked,
    })
  }

  const billDiscount = input.billDiscount ?? ZERO
  /* Read here rather than passed in, so the counter, the draft it saves and the
     bill it becomes are all rounded by the same answer. The screen reads the
     same setting through the core context. */
  const totals = computeTotals(computed, billDiscount, supply, await loadRounding(db))

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

    await q(tx).insert(schema.billItems).values({
      id: newId(),
      billId,
      idx: i + 1,
      productId: line.productId,
      productName: line.productName,
      hsnCode: line.hsnCode,
      saleUnit: line.saleUnit,
      qty: line.qty,
      baseQty: line.baseQty,
      rate: line.rate,
      mrp: line.mrp,
      discount: add(line.discount, t.billDiscountShare),
      lineTotal: t.net,
      taxableValue: t.tax.taxableValue,
      taxRateBp: line.taxRateBp,
      cgstAmount: t.tax.cgst,
      sgstAmount: t.tax.sgst,
      igstAmount: t.tax.igst,
      priceSource: line.priceSource,
      priceSourceId: line.priceSourceId,
      discountBlocked: line.discountBlocked ? 1 : 0,
      loyaltyBlocked: line.loyaltyBlocked ? 1 : 0,
    })
  }
}

export async function createBill(db: SqlDriver, input: CreateBillInput): Promise<CreateBillResult> {
  const priced = await priceBill(db, input)
  if (!priced.ok) return priced

  const { computed, totals, meta, subtotal } = priced
  const billId = newId()
  const nowIso = meta.now.toISOString()

  await db.transaction(async (tx) => {
    /* The row goes in with its money at zero and is filled in below, after the
       lines have been written. That order is older than this rewrite and worth
       keeping: the lines are what the totals are *of*, and a bill row carrying
       a grand total with nothing under it is a state no reader should ever be
       able to see, even inside a transaction. */
    await q(tx).insert(schema.bills).values({
      id: billId,
      docNo: `DRAFT-${billId}`,
      docstatus: DRAFT,
      registerId: input.registerId,
      sessionId: meta.sessionId,
      customerId: meta.customerId,
      customerName: meta.customerName,
      postingDate: meta.postingDate,
      discount: meta.billDiscount,
      placeOfSupply: meta.placeOfSupply,
      notes: meta.notes,
      convertedFrom: input.convertedFrom ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    await writeLines(tx, billId, computed, totals)

    await q(tx).update(schema.bills)
      .set({
        subtotal,
        taxableTotal: totals.taxableTotal,
        taxTotal: totals.taxTotal,
        roundOff: totals.roundOff,
        grandTotal: totals.grandTotal,
      })
      .where(eq(schema.bills.id, billId))

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
  const [existing] = await q(db)
    .select({ docstatus: schema.bills.docstatus })
    .from(schema.bills)
    .where(eq(schema.bills.id, input.billId))
  if (!existing || existing.docstatus !== DRAFT) return { ok: false, code: 'NOT_A_DRAFT' }

  const priced = await priceBill(db, input)
  if (!priced.ok) return priced

  const { computed, totals, meta, subtotal } = priced

  await db.transaction(async (tx) => {
    await q(tx).delete(schema.billItems).where(eq(schema.billItems.billId, input.billId))
    await writeLines(tx, input.billId, computed, totals)

    await q(tx).update(schema.bills)
      .set({
        sessionId: meta.sessionId,
        customerId: meta.customerId,
        customerName: meta.customerName,
        postingDate: meta.postingDate,
        subtotal,
        discount: totals.discount,
        taxableTotal: totals.taxableTotal,
        taxTotal: totals.taxTotal,
        roundOff: totals.roundOff,
        grandTotal: totals.grandTotal,
        // Written plainly rather than kept: a cart cleared of the order's items
        // and refilled with others is no longer that order's bill, and the
        // counter is what knows which it is.
        placeOfSupply: meta.placeOfSupply,
        notes: meta.notes,
        convertedFrom: input.convertedFrom ?? null,
        updatedAt: meta.now.toISOString(),
      })
      /* The docstatus is in the WHERE and not merely checked above. The read
         that let this call through happened before the transaction opened, and
         a draft submitted by the other till in between must not be rewritten. */
      .where(and(eq(schema.bills.id, input.billId), eq(schema.bills.docstatus, DRAFT)))
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
    const [existing] = await q(db)
      .select({
        id: schema.bills.id,
        docNo: schema.bills.docNo,
        grandTotal: schema.bills.grandTotal,
      })
      .from(schema.bills)
      .where(eq(schema.bills.idempotencyKey, input.idempotencyKey))
    if (existing) {
      return {
        ok: true, billId: existing.id, docNo: existing.docNo,
        grandTotal: existing.grandTotal,
        // A replay reports nothing new: whatever was short was said at the time.
        pointsEarned: 0, pointsRedeemed: 0, idempotent: true, shortfalls: [],
      }
    }
  }

  const bill = await loadBill(db, input.billId)
  assertCanApply('bill', parseDocStatus(bill.docstatus), 'submit')

  /* Both guards are here and not in `createBill`, so a cart can always be
     built: a cashier scanning items must never be stopped halfway by a
     settings problem they cannot fix with a customer in front of them. They
     bite at the moment the document is issued, which is the moment either of
     them starts to matter. */
  const scheme = await loadTaxScheme(db)
  if (chargesTax(scheme)) {
    if (!isStateCode(await getSetting(db, 'shop_state_code'))) {
      return { ok: false, code: 'SHOP_STATE_UNSET' }
    }
    if (bill.grandTotal >= RULE_46F_THRESHOLD && bill.customerId === null) {
      return {
        ok: false, code: 'NEEDS_RECIPIENT',
        grandTotal: bill.grandTotal, threshold: RULE_46F_THRESHOLD,
      }
    }
  }

  const lines = await q(db)
    .select({
      productId: schema.billItems.productId,
      productName: schema.billItems.productName,
      baseQty: schema.billItems.baseQty,
      lineTotal: schema.billItems.lineTotal,
      loyaltyBlocked: schema.billItems.loyaltyBlocked,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, input.billId))
    .orderBy(schema.billItems.idx)

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
    productId: l.productId,
    productName: l.productName,
    required: l.baseQty,
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
    ...lines.filter((l) => l.loyaltyBlocked !== 1).map((l) => l.lineTotal),
  )
  const earned = calculateEarned(
    program,
    { grandTotal: bill.grandTotal, creditPortion: creditTotal, earningTotal },
    now,
  )
  const [register] = await q(db)
    .select({ prefix: schema.registers.prefix })
    .from(schema.registers)
    .where(eq(schema.registers.id, bill.registerId))
  const snapshot = await recipientSnapshot(db, bill)
  const nowIso = now.toISOString()
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'bill', register?.prefix ?? 'XX', now)

    for (const line of lines) {
      await postMovement(tx, {
        productId: line.productId,
        qtyChange: negQty(line.baseQty),
        voucherType: 'bill',
        voucherId: input.billId,
        postingDate: bill.postingDate,
        userId: input.actorId,
      })
    }

    for (const payment of input.payments) {
      await q(tx).insert(schema.billPayments).values({
        id: newId(),
        billId: input.billId,
        method: payment.method,
        amount: payment.amount,
        reference: payment.reference ?? null,
      })
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
      await q(tx).insert(schema.billPayments).values({
        id: newId(),
        billId: input.billId,
        method: 'loyalty',
        amount: redemptionValue,
        reference: `${pointsRedeemed} points`,
      })
    }

    for (const alloc of redemptionPlan) {
      /* Read-modify-write in one statement, so two tills redeeming from the
         same entry cannot both read the old figure. */
      await q(tx).update(schema.loyaltyEntries)
        .set({ consumed: sql`${schema.loyaltyEntries.consumed} + ${alloc.points}` })
        .where(eq(schema.loyaltyEntries.id, alloc.entryId))

      await q(tx).insert(schema.loyaltyRedemptions).values({
        id: newId(),
        customerId: bill.customerId!,
        billId: input.billId,
        loyaltyEntryId: alloc.entryId,
        points: alloc.points,
        createdAt: nowIso,
      })
    }

    if (earned.points > 0 && bill.customerId) {
      await q(tx).insert(schema.loyaltyEntries).values({
        id: newId(),
        customerId: bill.customerId,
        billId: input.billId,
        points: earned.points,
        earnedAt: nowIso,
        expiresAt: earned.expiresAt,
        createdAt: nowIso,
      })
    }

    await q(tx).update(schema.bills)
      .set({
        docstatus: SUBMITTED,
        docNo,
        paidTotal: sub(bill.grandTotal, creditTotal),
        creditTotal,
        idempotencyKey: input.idempotencyKey ?? null,
        // The document takes its own copy of what it said, here and nowhere later.
        // `reverse_charge` keeps its default of 0: nothing in this product raises
        // a bill under reverse charge, and a column that lies about it would be
        // worse than one that does not exist.
        supplyType: snapshot.supplyType,
        customerGstin: snapshot.gstin,
        customerAddress: snapshot.address,
        customerStateCode: snapshot.stateCode,
        updatedAt: nowIso,
      })
      .where(eq(schema.bills.id, input.billId))

    /* The order is marked off here and nowhere earlier. Loading an order onto
       the counter promises nothing; taking the money is the delivery. */
    if (bill.convertedFrom) {
      await applyBillFulfilment(tx, {
        billId: input.billId,
        documentId: bill.convertedFrom,
        actorId: input.actorId,
        now,
      })
    }

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

  const [returns] = await q(db)
    .select({ n: sql<number>`count(*)` })
    .from(schema.salesReturns)
    .where(and(
      eq(schema.salesReturns.billId, input.billId),
      eq(schema.salesReturns.docstatus, SUBMITTED),
    ))
  if ((returns?.n ?? 0) > 0) return { ok: false, code: 'HAS_RETURNS', returnCount: returns!.n }

  const [allocations] = await q(db)
    .select({ n: sql<number>`count(*)` })
    .from(schema.paymentAllocations)
    .innerJoin(schema.paymentEntries, and(
      eq(schema.paymentEntries.id, schema.paymentAllocations.paymentId),
      eq(schema.paymentEntries.docstatus, SUBMITTED),
    ))
    .where(eq(schema.paymentAllocations.billId, input.billId))
  if ((allocations?.n ?? 0) > 0) return { ok: false, code: 'HAS_PAYMENTS', paymentCount: allocations!.n }

  const nowIso = now.toISOString()

  /* Everything except credit. Credit moved no money on the way in, so there is
     nothing to hand back out of the drawer for it. */
  const tenders = await q(db)
    .select({ method: schema.billPayments.method, amount: schema.billPayments.amount })
    .from(schema.billPayments)
    .where(and(
      eq(schema.billPayments.billId, input.billId),
      ne(schema.billPayments.method, 'credit'),
    ))

  await db.transaction(async (tx) => {
    await reverseVoucher(tx, 'bill', input.billId, bill.postingDate, input.actorId)

    const session = await openSessionFor(tx, bill.registerId)
    if (session) {
      for (const tender of tenders) {
        await postCashMovement(tx, {
          sessionId: session,
          direction: 'out',
          amount: tender.amount,
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
    const redemptions = await q(tx)
      .select({
        id: schema.loyaltyRedemptions.id,
        loyaltyEntryId: schema.loyaltyRedemptions.loyaltyEntryId,
        owed: sql<number>`${schema.loyaltyRedemptions.points} - ${schema.loyaltyRedemptions.restored}`,
      })
      .from(schema.loyaltyRedemptions)
      .where(and(
        eq(schema.loyaltyRedemptions.billId, input.billId),
        isNull(schema.loyaltyRedemptions.reversedAt),
      ))

    for (const r of redemptions) {
      if (r.owed > 0) {
        await q(tx).update(schema.loyaltyEntries)
          .set({ consumed: sql`${schema.loyaltyEntries.consumed} - ${r.owed}` })
          .where(eq(schema.loyaltyEntries.id, r.loyaltyEntryId))
      }
      await q(tx).update(schema.loyaltyRedemptions)
        .set({ reversedAt: nowIso })
        .where(eq(schema.loyaltyRedemptions.id, r.id))
    }

    await q(tx).update(schema.loyaltyEntries)
      .set({ cancelledAt: nowIso })
      .where(and(
        eq(schema.loyaltyEntries.billId, input.billId),
        isNull(schema.loyaltyEntries.cancelledAt),
      ))

    /* What this bill took off an order goes back. Otherwise a cancelled bill
       leaves an order claiming it was delivered, and the goods are never sent. */
    await reverseBillFulfilment(tx, { billId: input.billId, actorId: input.actorId })

    await q(tx).update(schema.bills)
      .set({
        docstatus: CANCELLED,
        cancelledBy: input.actorId,
        cancelledAt: nowIso,
        cancelReason: input.reason ?? null,
        updatedAt: nowIso,
      })
      .where(eq(schema.bills.id, input.billId))

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

  const lines = await q(db)
    .select({
      productId: schema.billItems.productId,
      saleUnit: schema.billItems.saleUnit,
      qty: schema.billItems.qty,
      rate: schema.billItems.rate,
      discount: schema.billItems.discount,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, input.billId))
    .orderBy(schema.billItems.idx)

  /* Everything the original charged, to the paisa.
     The line discount was being selected and then dropped on the floor, and the
     notes were never read at all -- so amending a bill of 1,000 rupees less 100
     produced a draft for the full 1,000, with tax on the full 1,000. A shop
     correcting one line of a discounted bill handed the customer a *larger*
     bill than the one being corrected, and the discount had to be found on the
     cancelled copy and typed in again.

     ── Why the bill discount is not passed as a bill discount ──────────────
     `computeTotals` spreads a bill-level discount across the lines that may
     carry it, and `bill_items.discount` is stored as the line's own discount
     *plus* its share of that spread. The split is not recoverable from the
     stored row: the shares are apportioned by weights that are themselves
     computed from the own-discounts. So carrying the line discounts and the
     bill discount would subtract the same money twice -- 1,000 less 100 would
     amend to 900 less another 100. The first version of this did exactly that
     and the test below caught it.

     Carrying the stored line discounts alone reproduces the original exactly:
     every line's net, taxable value and tax are identical, and so is the total.
     What is not reproduced is the presentation -- the amendment shows the whole
     reduction against the lines rather than some of it on the bill. That is a
     difference in how it reads, not in what is owed, and it is the honest one
     of the two available answers.

     ── Why the posting date is not carried ─────────────────────────────────
     This is a new document raised today. Under GST there is no amended
     invoice, only a cancellation and a fresh one, so it takes today's date and
     its own number from the same series. Carrying the old date would back-date
     a document into a period that may already have been filed. `createBill`
     defaults it, so it is simply not passed. */
  const created = await createBill(db, {
    registerId: source.registerId,
    customerId: source.customerId,
    /* The order comes with it. Cancelling the original gave the order back what
       it had taken, so an amendment that dropped the link would leave the order
       open for goods the shop is about to send out again. */
    convertedFrom: source.convertedFrom,
    lines: lines.map((l) => ({
      productId: l.productId,
      saleUnit: l.saleUnit,
      qty: l.qty,
      rateOverride: l.rate,
      discount: l.discount,
    })),
    ...(source.notes !== null ? { notes: source.notes } : {}),
    actorId: input.actorId,
    ...(input.now ? { now: input.now } : {}),
  })

  if (!created.ok) return created

  await db.transaction(async (tx) => {
    await q(tx).update(schema.bills)
      .set({ amendedFrom: input.billId })
      .where(eq(schema.bills.id, created.billId))
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
  convertedFrom: string | null
  /** Carried into an amendment. See `amendBill`. */
  discount: Money
  notes: string | null
  /** The state the lines were taxed against. See `recipientSnapshot`. */
  placeOfSupply: string | null
}

async function loadBill(db: SqlDriver, billId: string): Promise<BillRow> {
  const [row] = await q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      docstatus: schema.bills.docstatus,
      registerId: schema.bills.registerId,
      sessionId: schema.bills.sessionId,
      customerId: schema.bills.customerId,
      postingDate: schema.bills.postingDate,
      grandTotal: schema.bills.grandTotal,
      convertedFrom: schema.bills.convertedFrom,
      discount: schema.bills.discount,
      notes: schema.bills.notes,
      placeOfSupply: schema.bills.placeOfSupply,
    })
    .from(schema.bills)
    .where(eq(schema.bills.id, billId))
  if (!row) throw new Error(`unknown bill: ${billId}`)
  return row
}

interface RecipientSnapshot {
  supplyType: SupplyType
  gstin: string | null
  address: string | null
  stateCode: string | null
}

/**
 * Who the invoice was issued to, decided once, at submit, and never read off a
 * live join again.
 *
 * Migration 028 gave `bills` these columns for one reason: this product read the
 * recipient's name, address, GSTIN and place of supply out of `customers` every
 * time anybody reprinted a bill or ran a GST export, so a customer who moved
 * premises or corrected their GSTIN silently rewrote every invoice ever issued
 * to them. A reprint stopped matching the copy in the customer's hand.
 *
 * The GSTIN and the address are taken from the customer as they stand now,
 * because now is when the document is being issued.
 *
 * The state is not. It is taken from `bills.place_of_supply`, which is the value
 * `priceBill` decided the tax against when the cart was priced. Reading the
 * customer's state a second time here would let a record corrected between the
 * draft being saved and the money being taken produce a bill whose stated place
 * of supply contradicts the tax printed on its own lines — CGST+SGST under a
 * heading that says Maharashtra. Whatever else is true, a document may not
 * disagree with itself. `supply_type` is derived from the same value for the
 * same reason.
 */
async function recipientSnapshot(db: SqlDriver, bill: BillRow): Promise<RecipientSnapshot> {
  const [customer] = bill.customerId
    ? await q(db)
        .select({ gstin: schema.customers.gstin, address: schema.customers.address })
        .from(schema.customers)
        .where(eq(schema.customers.id, bill.customerId))
    : []

  return {
    supplyType: await supplyFor(db, bill.placeOfSupply),
    gstin: customer?.gstin ?? null,
    address: customer?.address ?? null,
    stateCode: bill.placeOfSupply,
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
  const [row] = await q(db)
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      stateCode: schema.customers.stateCode,
      priceListId: schema.customers.priceListId,
      creditLimit: schema.customers.creditLimit,
      creditEnforcement: schema.customers.creditEnforcement,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
  if (!row) throw new Error(`unknown customer: ${customerId}`)
  return {
    ...row,
    /* The column is a plain TEXT with a CHECK on it, so the three values it can
       hold are a fact about the table that the type system cannot see. */
    creditEnforcement: row.creditEnforcement as 'none' | 'soft' | 'hard',
  }
}

async function loadOpenBills(db: SqlDriver, customerId: string): Promise<OpenBill[]> {
  /* raw: a correlated subquery, which the query builder has no shape for.
     A join to the allocations would multiply the bill row once per payment
     against it, so a bill settled in three instalments would count its own
     credit total three times.

     `bills.id` is written out rather than interpolated as a column: inside a
     subquery Drizzle renders the reference unqualified, and a bare `id` there
     binds to `payment_allocations` and `payment_entries` first -- SQLite calls
     it ambiguous and refuses, which is the good outcome of the two available. */
  const allocated = sql<Money>`COALESCE((
    SELECT SUM(pa.amount) FROM payment_allocations pa
      JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = ${SUBMITTED}
     WHERE pa.bill_id = bills.id), 0)`

  return q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      postingDate: schema.bills.postingDate,
      creditTotal: schema.bills.creditTotal,
      allocated,
    })
    .from(schema.bills)
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
      gt(schema.bills.creditTotal, ZERO),
    ))
}

async function loadLoyaltyEntries(db: SqlDriver, customerId: string): Promise<LoyaltyEntry[]> {
  return q(db)
    .select({
      id: schema.loyaltyEntries.id,
      points: schema.loyaltyEntries.points,
      consumed: schema.loyaltyEntries.consumed,
      earnedAt: schema.loyaltyEntries.earnedAt,
      expiresAt: schema.loyaltyEntries.expiresAt,
      cancelledAt: schema.loyaltyEntries.cancelledAt,
    })
    .from(schema.loyaltyEntries)
    .where(eq(schema.loyaltyEntries.customerId, customerId))
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
