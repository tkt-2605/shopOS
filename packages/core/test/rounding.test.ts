import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { computeTotals, roundOffFor, type Rounding } from '../src/domain/billTotals.js'
import { loadRounding, setRounding, ROUNDING_DEFAULT } from '../src/services/features.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import { rupees, paise, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { buildReceipt, previewLines, type ReceiptDoc } from '../src/domain/receipt.js'
import { buildInvoiceHtml } from '../src/domain/invoiceHtml.js'
import { STANDARD_RECEIPT, STANDARD_INVOICE } from '../src/domain/docFormat.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * The last few paise.
 *
 * `bills.round_off` has been a column since migration 001 and the reports have
 * summed it for as long as they have existed; until now nothing wrote anything
 * but a literal zero into it. These are the rules that fill it.
 *
 * The theme worth defending is the one in the middle: rounding moves the total
 * and nothing else. A shop that rounded its taxable value to make the total
 * come out even would file a return against figures its own invoices do not
 * carry.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost: 5000 as Money,
      voucherType: 'opening',
      voucherId: newId(),
      postingDate: '2026-01-01',
    })
  })
}

/** One line of `rate`, taxed at 18%, so the total lands off a whole rupee. */
function oneLine(rate: Money, rounding: Rounding) {
  return computeTotals([{ qty: fromUnits(1), rate, taxRateBp: 1800 }], 0 as Money, 'intra_state', rounding)
}

describe('the rule itself', () => {
  it('charges what the bill comes to when the shop has not asked for rounding', () => {
    expect(roundOffFor(paise(9960), 'none')).toBe(0)
    expect(oneLine(paise(9960), 'none').grandTotal).toBe(9960)
  })

  it('takes the nearer rupee, in both directions', () => {
    expect(roundOffFor(paise(9960), 'nearest')).toBe(40)
    expect(roundOffFor(paise(9940), 'nearest')).toBe(-40)
  })

  it('always finds a rupee for the shop when asked to round up', () => {
    expect(roundOffFor(paise(9910), 'up')).toBe(90)
    expect(roundOffFor(paise(9990), 'up')).toBe(10)
  })

  it('always gives the paise up when asked to round down', () => {
    expect(roundOffFor(paise(9990), 'down')).toBe(-90)
    expect(roundOffFor(paise(9910), 'down')).toBe(-10)
  })

  it('leaves a total that is already whole rupees alone, whatever the rule', () => {
    for (const rule of ['none', 'nearest', 'up', 'down'] as Rounding[]) {
      expect(roundOffFor(rupees(100), rule), rule).toBe(0)
    }
  })
})

describe('what rounding is allowed to move', () => {
  it('moves the total and nothing else', () => {
    const plain = oneLine(paise(9960), 'none')
    const rounded = oneLine(paise(9960), 'nearest')

    // The figures a return is filed on are untouched.
    expect(rounded.taxableTotal).toBe(plain.taxableTotal)
    expect(rounded.taxTotal).toBe(plain.taxTotal)
    expect(rounded.subtotal).toBe(plain.subtotal)
    expect(rounded.lines[0]!.net).toBe(plain.lines[0]!.net)

    expect(rounded.grandTotal).toBe(10000)
  })

  it('keeps the total reconcilable — what the lines come to, plus the adjustment', () => {
    for (const rule of ['none', 'nearest', 'up', 'down'] as Rounding[]) {
      const t = oneLine(paise(9960), rule)
      expect(t.payable + t.roundOff, rule).toBe(t.grandTotal)
    }
  })
})

describe('the shop’s answer', () => {
  it('charges what the bill comes to until a shop says otherwise', async () => {
    expect(await loadRounding(fx.db)).toBe(ROUNDING_DEFAULT)
    expect(ROUNDING_DEFAULT).toBe('none')
  })

  it('records who changed it', async () => {
    await setRounding(fx.db, { actorId: fx.adminId }, 'nearest')
    expect(await loadRounding(fx.db)).toBe('nearest')

    const row = await fx.db.get<{ actor_id: string; diff: string }>(
      `SELECT actor_id, diff FROM audit_log WHERE entity = 'settings' AND entity_id = 'round_off_rule'`,
    )
    expect(row?.actor_id).toBe(fx.adminId)
    expect(row?.diff).toContain('nearest')
  })
})

describe('a bill that is rounded', () => {
  it('writes the adjustment into the column the reports have always summed', async () => {
    await setRounding(fx.db, { actorId: fx.adminId }, 'nearest')
    const p = await makeProduct(fx.db, { baseRate: paise(9960), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)

    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    expect(bill.ok).toBe(true)
    if (!bill.ok) return

    const row = await fx.db.get<{ round_off: number; grand_total: number }>(
      `SELECT round_off, grand_total FROM bills WHERE id = ?`, [bill.billId],
    )
    expect(row?.round_off).toBe(40)
    expect(row?.grand_total).toBe(10000)
  })

  it('asks for the rounded figure at the counter, not the one the lines came to', async () => {
    await setRounding(fx.db, { actorId: fx.adminId }, 'nearest')
    const p = await makeProduct(fx.db, { baseRate: paise(9960), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)

    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error('draft refused')

    // The old total is now the wrong money: the payment has to match the bill.
    const short = await submitBill(fx.db, {
      billId: bill.billId,
      payments: [{ method: 'cash', amount: paise(9960) }],
      actorId: fx.adminId,
    })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.code).toBe('PAYMENT_MISMATCH')

    const exact = await submitBill(fx.db, {
      billId: bill.billId,
      payments: [{ method: 'cash', amount: paise(10000) }],
      actorId: fx.adminId,
    })
    expect(exact.ok).toBe(true)
  })

  it('leaves round_off at zero for a shop that has never asked for it', async () => {
    const p = await makeProduct(fx.db, { baseRate: paise(9960), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)

    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error('draft refused')

    const row = await fx.db.get<{ round_off: number; grand_total: number }>(
      `SELECT round_off, grand_total FROM bills WHERE id = ?`, [bill.billId],
    )
    expect(row?.round_off).toBe(0)
    expect(row?.grand_total).toBe(9960)
  })
})

describe('what the customer is shown', () => {
  const doc = (roundOff: number | undefined): ReceiptDoc => ({
    shop: { name: 'Test Shop', address: null, phone: null, gstin: null },
    docNo: 'INV/1',
    postingDate: '2026-09-14',
    items: [{ name: 'Thing', qty: fromUnits(1), saleUnit: 'piece', rate: paise(9960), lineTotal: paise(9960) }],
    subtotal: paise(9960),
    discount: 0 as Money,
    taxableTotal: paise(9960),
    cgst: 0 as Money,
    sgst: 0 as Money,
    igst: 0 as Money,
    ...(roundOff === undefined ? {} : { roundOff: roundOff as Money }),
    grandTotal: paise(roundOff === undefined ? 9960 : 9960 + roundOff),
    payments: [],
  })

  it('names the adjustment on the roll, with its sign', () => {
    const lines = previewLines(buildReceipt(doc(40), STANDARD_RECEIPT)).map((l) => l.text)
    expect(lines.some((l) => l.includes('Round off') && l.includes('+0.40'))).toBe(true)
  })

  it('says so when the shop gave the paise up, rather than showing a bare figure', () => {
    const lines = previewLines(buildReceipt(doc(-40), STANDARD_RECEIPT)).map((l) => l.text)
    expect(lines.some((l) => l.includes('Round off') && l.includes('-0.40'))).toBe(true)
  })

  it('prints no round-off line at all on a bill that was never rounded', () => {
    const lines = previewLines(buildReceipt(doc(undefined), STANDARD_RECEIPT)).map((l) => l.text)
    expect(lines.some((l) => l.includes('Round off'))).toBe(false)

    expect(buildInvoiceHtml(doc(undefined), STANDARD_INVOICE)).not.toContain('Round off')
  })

  it('carries it onto the sheet as well as the roll', () => {
    expect(buildInvoiceHtml(doc(40), STANDARD_INVOICE)).toContain('Round off')
  })
})
