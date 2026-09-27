import type { Money } from '../../money.js'
import type { Qty } from '../../quantity.js'
import type { PriceSource } from '../../domain/pricing.js'
import type { StockShortfall } from '../stock.js'

/*
 * What a bill is asked for with, and what it answers.
 */

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
  /**
   * The batch the cashier chose for a line, by the line's position (1 first,
   * as `bill_items.idx`). A line not named here comes out of its batches soonest
   * expiry first; see `allocate` in domain/batches.ts.
   */
  batchPicks?: Readonly<Record<number, string>>
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
  /** A discount below zero is a surcharge nobody authorised. */
  | { ok: false; code: 'NEGATIVE_DISCOUNT' }

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
  /**
   * A tender of nothing or less, or one that claims to be points. Points are
   * paid through `redeemPoints`, which checks the customer holds them; a
   * `loyalty` tender would settle the bill with points nobody spent.
   */
  | { ok: false; code: 'INVALID_PAYMENT' }
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
