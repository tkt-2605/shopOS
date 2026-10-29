import { type Money, ZERO, add, sub, paise } from '../money.js'

/**
 * The marker a second opening advance is spotted by.
 *
 * In `reference` rather than parsed back out of the document number. The
 * number is `MARK + registerPrefix + '/' + fy + '/' + seq` (`numbering.ts`),
 * so a `LIKE 'OA%'` misses it by exactly the one leading letter -- which is
 * how the first version of this shipped a guard that never fired. A column
 * this code sets and reads, compared with `=`, cannot drift with a format.
 *
 * Here rather than beside the khata, because the general ledger reads it too:
 * an opening advance is money held from the old book, not money taken today.
 */
export const OPENING_ADVANCE_REF = 'opening-balance'

/**
 * Outstanding is derived from documents, never held in a mutable column. The
 * previous system kept both a `customers.balance` field and a `balance_after`
 * running total, and shipped an RPC whose job was to resync them when they
 * disagreed — which is the whole argument against storing it.
 */

export interface OpenBill {
  id: string
  docNo: string
  postingDate: string
  creditTotal: Money
  allocated: Money
}

export function billOutstanding(bill: OpenBill): Money {
  return sub(bill.creditTotal, bill.allocated)
}

export function totalOutstanding(bills: OpenBill[]): Money {
  return bills.reduce<Money>((sum, b) => add(sum, billOutstanding(b)), ZERO)
}

export interface PaymentAllocation {
  billId: string
  amount: Money
}

export interface AllocationPlan {
  allocations: PaymentAllocation[]
  allocated: Money
  unallocated: Money
}

/** Oldest bill first — the convention a shopkeeper expects when clearing khata. */
export function planAllocation(payment: Money, openBills: OpenBill[]): AllocationPlan {
  if (payment <= 0) {
    return { allocations: [], allocated: ZERO, unallocated: ZERO }
  }

  const ordered = [...openBills].sort((a, b) =>
    a.postingDate === b.postingDate ? a.docNo.localeCompare(b.docNo) : a.postingDate.localeCompare(b.postingDate),
  )

  const allocations: PaymentAllocation[] = []
  let remaining: Money = payment

  for (const bill of ordered) {
    if (remaining <= 0) break
    const due = billOutstanding(bill)
    if (due <= 0) continue
    const amount = paise(Math.min(remaining, due))
    allocations.push({ billId: bill.id, amount })
    remaining = sub(remaining, amount)
  }

  return { allocations, allocated: sub(payment, remaining), unallocated: remaining }
}

export type CreditEnforcement = 'none' | 'soft' | 'hard'

export interface CreditCheckInput {
  creditLimit: Money
  enforcement: CreditEnforcement
  currentOutstanding: Money
  additionalCredit: Money
}

export type CreditCheck =
  | { allowed: true; warning: null; projected: Money }
  | { allowed: true; warning: 'OVER_LIMIT'; projected: Money; limit: Money; excess: Money }
  | { allowed: false; code: 'CREDIT_LIMIT_EXCEEDED'; projected: Money; limit: Money; excess: Money }

export function checkCreditLimit(input: CreditCheckInput): CreditCheck {
  const projected = add(input.currentOutstanding, input.additionalCredit)

  if (input.enforcement === 'none' || input.additionalCredit <= 0) {
    return { allowed: true, warning: null, projected }
  }
  /* A limit of zero is no credit at all (decided 28 Oct): the counter blocks
     or warns on any of it. A customer who may run up any amount is
     `enforcement: 'none'`, shown as "No limit". */
  if (projected <= input.creditLimit) {
    return { allowed: true, warning: null, projected }
  }

  const excess = sub(projected, input.creditLimit)
  if (input.enforcement === 'soft') {
    return { allowed: true, warning: 'OVER_LIMIT', projected, limit: input.creditLimit, excess }
  }
  return { allowed: false, code: 'CREDIT_LIMIT_EXCEEDED', projected, limit: input.creditLimit, excess }
}
