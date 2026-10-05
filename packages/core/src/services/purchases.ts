import type { SqlDriver } from '../db/driver.js'
import { type Money, ZERO, add } from '../money.js'
import type { Qty } from '../quantity.js'
import { grossOf } from '../domain/billTotals.js'
import { addTax, supplyTypeFor, type TaxBreakdown } from '../domain/tax.js'
import { stateFromGstin } from '../domain/gstin.js'
import { chargesTax } from '../domain/taxScheme.js'
import { getSetting } from './settings.js'
import { loadTaxScheme } from './features.js'

/*
 * The tax on a supplier's bill (065).
 *
 * A purchase line's cost is before tax, as a supplier quotes it, and the GST
 * goes on top -- on the same taxable value, at the rate the line is billed at,
 * with IGST when the supplier's GSTIN is in another state. Nothing here guesses
 * a rate: a line carries the rates the person entering the bill gave it (the
 * Stock In screen fills them in from the item, where they can be corrected),
 * and a line given none carries none, which is what every purchase recorded
 * before 065 says.
 */

export interface PurchaseLine {
  qty: Qty
  unitCost: Money
  taxRateBp?: number
  cessRateBp?: number
}

export interface PurchaseLineTax extends TaxBreakdown {}

/** The GST on each line of a supplier's bill, and what the bill comes to. */
export async function purchaseTaxes(
  db: SqlDriver,
  input: { supplierId: string | null; lines: readonly PurchaseLine[]; roundOff?: Money },
): Promise<{ lines: PurchaseLineTax[]; invoiceTotal: Money }> {
  const supplier = input.supplierId
    ? await db.get<{ gstin: string | null }>(`SELECT gstin FROM suppliers WHERE id = ?`, [input.supplierId])
    : undefined
  const supply = supplyTypeFor(stateFromGstin(supplier?.gstin ?? null), await getSetting(db, 'shop_state_code'))

  const lines = input.lines.map((l) =>
    addTax(grossOf(l.unitCost, l.qty), l.taxRateBp ?? 0, supply, l.cessRateBp ?? 0))
  const invoiceTotal = add(
    ...lines.map((t) => add(t.taxableValue, t.taxTotal)),
    input.roundOff ?? ZERO,
  )
  return { lines, invoiceTotal }
}

/**
 * Whether the GST on a purchase is the shop's to claim back.
 *
 * A registered shop sets it against the tax it collects, so it is not part of
 * what the goods cost. A composition dealer or an unregistered shop may not
 * claim it, so it is: their stock is valued with the tax in it.
 */
export async function inputTaxClaimable(db: SqlDriver): Promise<boolean> {
  return chargesTax(await loadTaxScheme(db))
}
