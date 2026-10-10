import { and, eq, gte, lte, ne, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, formatWithSymbol as formatMoney, sub } from '../../money.js'
import { supplyTypeFor, type SupplyType } from '../../domain/tax.js'
import { type LoyaltyProgram, type LoyaltyEntry, DEFAULT_PROGRAM, availablePoints } from '../../domain/loyalty.js'
import { getSetting } from '../settings.js'
import type { BillTotals } from './types.js'

/*
 * The reads a bill's stages share: the bill itself, its customer, what they
 * already owe, and the loyalty they hold.
 */

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

export async function loadBill(db: SqlDriver, billId: string): Promise<BillRow> {
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
export async function recipientSnapshot(db: SqlDriver, bill: BillRow): Promise<RecipientSnapshot> {
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

/** A customer as billing needs them: name, credit limit and how it is enforced. */
export async function billingCustomer(db: SqlDriver, customerId: string): Promise<CustomerRow> {
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

export async function loadLoyaltyEntries(db: SqlDriver, customerId: string): Promise<LoyaltyEntry[]> {
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

/**
 * What the paper says about points: what this bill earned, and what the customer
 * holds now. Read from the entry the bill wrote at submit, so a reprint matches
 * the loyalty ledger and not a recomputation. Null for a walk-in, or a bill that
 * earned nothing, which prints no block.
 */
export async function loadBillLoyalty(
  db: SqlDriver, billId: string, customerId: string | null,
): Promise<{ pointsEarned: number; pointsBalance: number } | null> {
  if (!customerId) return null
  const [entry] = await q(db)
    .select({ points: schema.loyaltyEntries.points, earned: schema.loyaltyEntries.earned,
              cancelledAt: schema.loyaltyEntries.cancelledAt })
    .from(schema.loyaltyEntries)
    .where(eq(schema.loyaltyEntries.billId, billId))
  if (!entry || entry.cancelledAt !== null) return null
  const pointsEarned = entry.earned ?? entry.points
  if (pointsEarned <= 0) return null
  return { pointsEarned, pointsBalance: availablePoints(await loadLoyaltyEntries(db, customerId)) }
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

/**
 * What a customer has spent so far in the month of `postingDate`, for the
 * loyalty program's monthly target.
 *
 * On the same footing a bill earns on: submitted sales, the lines that take
 * part in the programme, less what was refunded on those lines. A return is
 * counted against the month of the bill it returns, not the month it was
 * made in, so taking a bill back in the next month does not reach back and
 * lower a target the customer has already been told they reached.
 *
 * `excludeBillId` leaves out the bill being asked about. A draft is not
 * submitted and would not be counted anyway; the parameter is for a bill
 * already submitted, where the question is what came before it.
 */
export async function monthToDateSpend(
  db: SqlDriver,
  customerId: string,
  postingDate: string,
  excludeBillId?: string,
): Promise<Money> {
  const monthStart = `${postingDate.slice(0, 7)}-01`
  const onTheseBills = and(
    eq(schema.bills.customerId, customerId),
    eq(schema.bills.docstatus, 1),
    eq(schema.bills.kind, 'sale'),
    gte(schema.bills.postingDate, monthStart),
    lte(schema.bills.postingDate, postingDate),
    eq(schema.billItems.loyaltyBlocked, 0),
    excludeBillId ? ne(schema.bills.id, excludeBillId) : undefined,
  )

  const [sold] = await q(db)
    .select({ total: sql<number>`coalesce(sum(${schema.billItems.lineTotal}), 0)` })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(onTheseBills)

  const [refunded] = await q(db)
    .select({ total: sql<number>`coalesce(sum(${schema.salesReturnItems.refundAmount}), 0)` })
    .from(schema.salesReturnItems)
    .innerJoin(schema.salesReturns, eq(schema.salesReturns.id, schema.salesReturnItems.returnId))
    .innerJoin(schema.billItems, eq(schema.billItems.id, schema.salesReturnItems.billItemId))
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(and(onTheseBills, eq(schema.salesReturns.docstatus, 1)))

  const spent = sub((sold?.total ?? 0) as Money, (refunded?.total ?? 0) as Money)
  return (spent > 0 ? spent : 0) as Money
}

export async function supplyFor(db: SqlDriver, customerStateCode: string | null): Promise<SupplyType> {
  const shopState = await getSetting(db, 'shop_state_code')
  return supplyTypeFor(shopState, customerStateCode)
}

export function billSummary(totals: BillTotals, lineCount: number): string {
  return `${lineCount} item${lineCount === 1 ? '' : 's'}, ${formatMoney(totals.grandTotal)}`
}
