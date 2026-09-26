import type { SqlDriver } from '../../db/driver.js'
import type { Money } from '../../money.js'
import { checkCreditLimit, totalOutstanding } from '../../domain/credit.js'
import { chargesTax } from '../../domain/taxScheme.js'
import { isStateCode } from '../../domain/states.js'
import { loadTaxScheme } from '../features.js'
import { getSetting } from '../settings.js'
import { billingCustomer } from './load.js'
import { loadOpenBills } from '../payments/outstanding.js'
import { RULE_46F_THRESHOLD, type SubmitBillResult } from './types.js'

/*
 * What stops a bill being issued, asked before anything is written.
 *
 * Each answers null when the bill may go ahead, or the refusal `submitBill`
 * returns as it stands. Kept apart from the submit itself so the order it asks
 * them in reads as a list, and so each can be read without the transaction
 * around it.
 */

type Refusal = Extract<SubmitBillResult, { ok: false }>

/**
 * The two guards a tax invoice has and a bill of supply does not.
 *
 * Both are here and not in `createBill`, so a cart can always be built: a
 * cashier scanning items must never be stopped halfway by a settings problem
 * they cannot fix with a customer in front of them. They bite at the moment the
 * document is issued, which is the moment either of them starts to matter.
 */
export async function refusedAsInvoice(
  db: SqlDriver,
  bill: { grandTotal: Money; customerId: string | null },
): Promise<Refusal | null> {
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
  return null
}

/** Whether the credit on this bill takes the customer past what they are allowed. */
export async function refusedOnCredit(
  db: SqlDriver,
  customerId: string,
  creditTotal: Money,
): Promise<Refusal | null> {
  const customer = await billingCustomer(db, customerId)
  const outstanding = totalOutstanding(await loadOpenBills(db, customerId))
  const check = checkCreditLimit({
    creditLimit: customer.creditLimit,
    enforcement: customer.creditEnforcement,
    currentOutstanding: outstanding,
    additionalCredit: creditTotal,
  })
  if (!check.allowed) {
    return { ok: false, code: 'CREDIT_LIMIT_EXCEEDED', limit: check.limit, projected: check.projected, excess: check.excess }
  }
  return null
}
