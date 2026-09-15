import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setStockPolicy } from '../src/services/features.js'
import { rupees, paise, add, type Money } from '../src/money.js'
import { fromUnits, qty, toUnits } from '../src/quantity.js'
import { createBill, submitBill, cancelBill, amendBill } from '../src/services/billing.js'
import { currentStock, postMovement, recomputeStock } from '../src/services/stock.js'
import { fiscalYear, fiscalYearTag, nextDocNo, docNoFits, MAX_DOC_NO } from '../src/services/numbering.js'
import { setSetting } from '../src/services/bootstrap.js'
import { SUBMITTED, CANCELLED, DRAFT } from '../src/integrity/docstatus.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number, cost = 5000): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost: cost as Money,
      voucherType: 'opening',
      voucherId: newId(),
      postingDate: '2026-01-01',
    })
  })
}

async function billFor(productId: string, units: number, customerId?: string) {
  return createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(customerId ? { customerId } : {}),
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
}

describe('draft bills', () => {
  it('computes totals and tax without touching stock', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    await stockUp(fx.db, p, 10)

    const r = await billFor(p, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.grandTotal).toBe(rupees(236))
    expect(r.taxableTotal).toBe(rupees(200))
    expect(r.taxTotal).toBe(rupees(36))
    expect(add(r.taxableTotal, r.taxTotal)).toBe(r.grandTotal)

    expect(toUnits(await currentStock(fx.db, p))).toBe(10)
    const ledger = await fx.db.query(`SELECT id FROM stock_ledger WHERE voucher_type = 'bill'`)
    expect(ledger).toHaveLength(0)
  })

  it('records which rule set each price', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const r = await billFor(p, 1)
    expect(r.ok).toBe(true)

    const line = await fx.db.get<{ price_source: string }>(`SELECT price_source FROM bill_items`)
    expect(line?.price_source).toBe('base_rate')
  })

  it('marks a typed-in rate as a manual override', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1), rateOverride: rupees(55) }],
      actorId: fx.adminId,
    })
    const line = await fx.db.get<{ price_source: string; rate: number }>(`SELECT price_source, rate FROM bill_items`)
    expect(line?.price_source).toBe('manual_override')
    expect(line?.rate).toBe(rupees(55))
  })

  it('rejects an empty bill', async () => {
    const r = await createBill(fx.db, { registerId: fx.seed.registerId, lines: [], actorId: fx.adminId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NO_LINES')
  })

  it('rejects an unknown product', async () => {
    const r = await billFor('nope', 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNKNOWN_PRODUCT')
  })
})

describe('bill discount apportionment', () => {
  it('spreads across lines and still reconciles to the total', async () => {
    const a = await makeProduct(fx.db, { name: 'A', baseRate: rupees(100), taxRateBp: 1800 })
    const b = await makeProduct(fx.db, { name: 'B', baseRate: rupees(200), taxRateBp: 500 })
    await stockUp(fx.db, a, 10)
    await stockUp(fx.db, b, 10)

    const r = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: a, qty: fromUnits(1) }, { productId: b, qty: fromUnits(1) }],
      billDiscount: rupees(33.33),
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.grandTotal).toBe(rupees(266.67))

    const lines = await fx.db.query<{ line_total: number; taxable_value: number; cgst_amount: number; sgst_amount: number }>(
      `SELECT line_total, taxable_value, cgst_amount, sgst_amount FROM bill_items`,
    )
    const summedLines = lines.reduce((s, l) => s + l.line_total, 0)
    expect(summedLines).toBe(r.grandTotal)

    for (const l of lines) {
      expect(l.taxable_value + l.cgst_amount + l.sgst_amount).toBe(l.line_total)
    }
  })

  it('refuses a discount larger than the bill', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(10) })
    await stockUp(fx.db, p, 5)
    const r = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1) }],
      billDiscount: rupees(500),
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('DISCOUNT_EXCEEDS_TOTAL')
  })
})

describe('submitting', () => {
  it('moves stock, posts the ledger and assigns a real number', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 3)
    expect(draft.ok).toBe(true)
    if (!draft.ok) return

    const r = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.docNo).toMatch(/^BMR\/\d{4}\/00001$/)
    expect(toUnits(await currentStock(fx.db, p))).toBe(7)

    const bill = await fx.db.get<{ docstatus: number; paid_total: number }>(
      `SELECT docstatus, paid_total FROM bills WHERE id = ?`, [draft.billId],
    )
    expect(bill?.docstatus).toBe(SUBMITTED)
    expect(bill?.paid_total).toBe(draft.grandTotal)
  })

  it('refuses a payment that does not match the total', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return

    const r = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: rupees(50) }],
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PAYMENT_MISMATCH')
  })

  it('refuses to sell stock that is not there when the shop has asked it to', async () => {
    await setStockPolicy(fx.db, { actorId: fx.adminId }, 'block')
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 2)
    const draft = await billFor(p, 5)
    if (!draft.ok) return

    const r = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'INSUFFICIENT_STOCK') {
      expect(r.shortfalls[0]?.available).toBe(fromUnits(2))
      expect(r.shortfalls[0]?.required).toBe(fromUnits(5))
    }
    expect(toUnits(await currentStock(fx.db, p))).toBe(2)
  })

  it('sells a fractional quantity it actually has — the float trap', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 0.3)
    const draft = await billFor(p, 0.1)
    if (!draft.ok) return

    const r = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(true)
    expect(await currentStock(fx.db, p)).toBe(fromUnits(0.2))
  })

  it('replays an idempotency key instead of billing twice', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return

    const key = 'retry-1'
    const first = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }],
      idempotencyKey: key, actorId: fx.adminId,
    })
    const second = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }],
      idempotencyKey: key, actorId: fx.adminId,
    })

    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.idempotent).toBe(true)
      expect(second.docNo).toBe(first.docNo)
    }
    expect(toUnits(await currentStock(fx.db, p))).toBe(9)
  })

  it('cannot be submitted twice', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return

    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await expect(
      submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId }),
    ).rejects.toThrow(/cannot submit a submitted bill/)
  })
})

describe('credit', () => {
  it('blocks a credit sale past a hard limit', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(1000) })
    await stockUp(fx.db, p, 10)
    const c = await makeCustomer(fx.db)
    await fx.db.execute(`UPDATE customers SET credit_limit = ?, credit_enforcement = 'hard' WHERE id = ?`, [rupees(500), c])

    const draft = await billFor(p, 1, c)
    if (!draft.ok) return
    const r = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'credit', amount: draft.grandTotal }], actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'CREDIT_LIMIT_EXCEEDED') expect(r.excess).toBe(rupees(500))
  })

  it('refuses credit with no customer to bill it to', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return
    const r = await submitBill(fx.db, {
      billId: draft.billId, payments: [{ method: 'credit', amount: draft.grandTotal }], actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CREDIT_WITHOUT_CUSTOMER')
  })

  it('accumulates outstanding across bills', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 100)
    const c = await makeCustomer(fx.db)
    await fx.db.execute(`UPDATE customers SET credit_limit = ?, credit_enforcement = 'hard' WHERE id = ?`, [rupees(250), c])

    for (const expectOk of [true, true, false]) {
      const draft = await billFor(p, 1, c)
      if (!draft.ok) continue
      const r = await submitBill(fx.db, {
        billId: draft.billId, payments: [{ method: 'credit', amount: draft.grandTotal }], actorId: fx.adminId,
      })
      expect(r.ok).toBe(expectOk)
    }
  })
})

describe('cancellation', () => {
  it('puts stock back exactly', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 4)
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    expect(toUnits(await currentStock(fx.db, p))).toBe(6)

    const r = await cancelBill(fx.db, { billId: draft.billId, reason: 'wrong item', actorId: fx.adminId })
    expect(r.ok).toBe(true)
    expect(toUnits(await currentStock(fx.db, p))).toBe(10)

    const bill = await fx.db.get<{ docstatus: number; cancel_reason: string }>(
      `SELECT docstatus, cancel_reason FROM bills WHERE id = ?`, [draft.billId],
    )
    expect(bill?.docstatus).toBe(CANCELLED)
    expect(bill?.cancel_reason).toBe('wrong item')
  })

  it('leaves the reversal visible in the ledger rather than deleting history', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 4)
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })

    const rows = await fx.db.query<{ voucher_type: string; qty_change: number }>(
      `SELECT voucher_type, qty_change FROM stock_ledger WHERE voucher_id = ? ORDER BY rowid`, [draft.billId],
    )
    expect(rows.map((r) => r.voucher_type)).toEqual(['bill', 'bill_reversal'])
    expect(rows[0]!.qty_change + rows[1]!.qty_change).toBe(0)
  })

  it('cannot cancel a draft', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return
    await expect(cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })).rejects.toThrow(/cannot cancel a draft/)
  })

  it('cannot cancel twice', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })
    await expect(cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })).rejects.toThrow(/cancelled/)
  })
})

describe('amendment', () => {
  it('refuses to amend a live bill — cancel it first', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await expect(amendBill(fx.db, { billId: draft.billId, actorId: fx.adminId })).rejects.toThrow(/cancel it first/)
  })

  it('creates a new linked draft from a cancelled bill without double-deducting stock', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 3)
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })

    const amended = await amendBill(fx.db, { billId: draft.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
    if (!amended.ok) return

    // This is the bug the old system had: the amendment is a draft, so nothing
    // has been deducted twice.
    expect(toUnits(await currentStock(fx.db, p))).toBe(10)

    const row = await fx.db.get<{ amended_from: string; docstatus: number }>(
      `SELECT amended_from, docstatus FROM bills WHERE id = ?`, [amended.billId],
    )
    expect(row?.amended_from).toBe(draft.billId)
    expect(row?.docstatus).toBe(DRAFT)

    await submitBill(fx.db, { billId: amended.billId, payments: [{ method: 'cash', amount: amended.grandTotal }], actorId: fx.adminId })
    expect(toUnits(await currentStock(fx.db, p))).toBe(7)
  })
})

describe('loyalty through a bill', () => {
  beforeEach(async () => {
    await setSetting(fx.db, 'loyalty_program', JSON.stringify({
      enabled: true,
      tiers: [{ minSpend: 0, pointsPerHundred: 1 }],
      expiryDays: 365,
      pointValue: 100,
      earnOnCreditPortion: false,
      minBillForEarn: 0,
      maxRedeemFractionBp: 10_000,
    }))
  })

  it('earns on a cash bill', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)
    const c = await makeCustomer(fx.db)
    const draft = await billFor(p, 2, c)
    if (!draft.ok) return

    const r = await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    expect(r.ok && r.pointsEarned).toBe(10)
  })

  it('does not earn on the credit portion', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)
    const c = await makeCustomer(fx.db)
    await fx.db.execute(`UPDATE customers SET credit_enforcement = 'none' WHERE id = ?`, [c])
    const draft = await billFor(p, 2, c)
    if (!draft.ok) return

    const r = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: rupees(400) }, { method: 'credit', amount: rupees(600) }],
      actorId: fx.adminId,
    })
    expect(r.ok && r.pointsEarned).toBe(4)
  })

  it('redeems, then gives the exact points back on cancel', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await makeCustomer(fx.db)

    const first = await billFor(p, 2, c)
    if (!first.ok) return
    await submitBill(fx.db, { billId: first.billId, payments: [{ method: 'cash', amount: first.grandTotal }], actorId: fx.adminId })

    const second = await billFor(p, 2, c)
    if (!second.ok) return
    const r = await submitBill(fx.db, {
      billId: second.billId,
      payments: [{ method: 'cash', amount: rupees(990) }],
      redeemPoints: 10,
      actorId: fx.adminId,
    })
    expect(r.ok && r.pointsRedeemed).toBe(10)

    const consumedAfter = await fx.db.get<{ consumed: number }>(
      `SELECT consumed FROM loyalty_entries WHERE bill_id = ?`, [first.billId],
    )
    expect(consumedAfter?.consumed).toBe(10)

    await cancelBill(fx.db, { billId: second.billId, actorId: fx.adminId })
    const consumedBack = await fx.db.get<{ consumed: number }>(
      `SELECT consumed FROM loyalty_entries WHERE bill_id = ?`, [first.billId],
    )
    expect(consumedBack?.consumed).toBe(0)
  })

  it('voids points earned on a bill that is cancelled', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)
    const c = await makeCustomer(fx.db)
    const draft = await billFor(p, 2, c)
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })

    const entry = await fx.db.get<{ cancelled_at: string | null }>(
      `SELECT cancelled_at FROM loyalty_entries WHERE bill_id = ?`, [draft.billId],
    )
    expect(entry?.cancelled_at).not.toBeNull()
  })
})

describe('stock integrity', () => {
  it('shows zero drift after a mixed run of sales, cancels and amendments', async () => {
    const products = await Promise.all([
      makeProduct(fx.db, { name: 'A', baseRate: rupees(100) }),
      makeProduct(fx.db, { name: 'B', baseRate: rupees(250) }),
      makeProduct(fx.db, { name: 'C', baseRate: rupees(75) }),
    ])
    for (const p of products) await stockUp(fx.db, p, 500)

    for (let i = 0; i < 40; i++) {
      const p = products[i % products.length]!
      const draft = await billFor(p, 1 + (i % 4))
      if (!draft.ok) continue
      const submitted = await submitBill(fx.db, {
        billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
      })
      if (!submitted.ok) continue
      if (i % 5 === 0) await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })
    }

    expect(await recomputeStock(fx.db)).toEqual([])
  })

  it('detects drift when something writes stock behind the ledger', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 10)
    await fx.db.execute(`UPDATE product_stock SET qty_on_hand = 999 WHERE product_id = ?`, [p])

    const drift = await recomputeStock(fx.db)
    expect(drift).toHaveLength(1)
    expect(drift[0]?.actual).toBe(fromUnits(10))

    await recomputeStock(fx.db, { repair: true })
    expect(await recomputeStock(fx.db)).toEqual([])
  })
})

describe('numbering', () => {
  it('runs April to March', () => {
    expect(fiscalYear(new Date(2026, 5, 1))).toBe('26-27')
    expect(fiscalYear(new Date(2026, 2, 31))).toBe('25-26')
    expect(fiscalYear(new Date(2026, 3, 1))).toBe('26-27')
  })

  it('turns the year over by the shop’s clock, not by UTC', () => {
    /* This read getUTCMonth(), and India is UTC+5:30 — so a bill rung at one in
       the morning on the first of April was still the thirty-first of March in
       UTC. It did not merely print the old year: the fiscal year is part of the
       `doc_sequences` scope key, so the sale was counted into the outgoing
       year's series and the new year opened on a number already used. */
    const justAfterMidnight = new Date(2026, 3, 1, 1, 0, 0)
    expect(fiscalYear(justAfterMidnight)).toBe('26-27')

    const justBefore = new Date(2026, 2, 31, 23, 59, 59)
    expect(fiscalYear(justBefore)).toBe('25-26')
  })

  it('never mints a number longer than the law allows', async () => {
    /* Rule 46(b) caps an invoice serial at sixteen characters and Rule 53 says
       the same for a credit note. The old format was eighteen, and twenty-two
       on the six-character prefix that used to be allowed. */
    const on = new Date(2026, 5, 1)
    const longest = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', 'ABCD', on))
    expect(longest).toBe('BABCD/2627/00001')
    expect(longest.length).toBe(MAX_DOC_NO)
    expect(docNoFits(longest)).toBe(true)

    // And the old shape is what it refuses.
    expect(docNoFits('INV/MR/26-27/00001')).toBe(false)
  })

  it('gives a bill and a credit note different numbers', async () => {
    /* They are separate series, so both legitimately reach 00001. Without the
       letter they would print the identical string and a customer would hold two
       documents bearing one number. */
    const on = new Date(2026, 5, 1)
    const bill = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', 'MR', on))
    const note = await fx.db.transaction((tx) => nextDocNo(tx, 'return', 'MR', on))
    expect(bill).toBe('BMR/2627/00001')
    expect(note).toBe('CMR/2627/00001')
    expect(bill).not.toBe(note)
  })

  it('keeps separate series per register', async () => {
    await fx.db.execute(
      `INSERT INTO registers (id, name, prefix, created_at, updated_at) VALUES ('r2', 'Second', 'SR', '2026-01-01', '2026-01-01')`,
    )
    const on = new Date(2026, 5, 1)
    const a = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', 'MR', on))
    const b = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', 'SR', on))
    expect(a).toBe('BMR/2627/00001')
    expect(b).toBe('BSR/2627/00001')
  })

  it('restarts the series in a new fiscal year', async () => {
    const first = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', 'MR', new Date(2026, 5, 1)))
    const next = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', 'MR', new Date(2027, 5, 1)))
    expect(first).toBe('BMR/2627/00001')
    expect(next).toBe('BMR/2728/00001')
  })

  it('gives submitted bills a gapless series even when drafts are abandoned', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 100)

    await billFor(p, 1)
    await billFor(p, 1)

    const numbers: string[] = []
    for (let i = 0; i < 3; i++) {
      const draft = await billFor(p, 1)
      if (!draft.ok) continue
      const r = await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
      if (r.ok) numbers.push(r.docNo)
    }

    expect(numbers).toEqual([
      'BMR/' + fiscalYearTag(new Date()) + '/00001',
      'BMR/' + fiscalYearTag(new Date()) + '/00002',
      'BMR/' + fiscalYearTag(new Date()) + '/00003',
    ])
  })
})

describe('audit trail through a bill lifecycle', () => {
  it('records create, submit and cancel with the status transitions', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await billFor(p, 1)
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    await cancelBill(fx.db, { billId: draft.billId, actorId: fx.adminId })

    const rows = await fx.db.query<{ action: string; docstatus_from: number | null; docstatus_to: number | null }>(
      `SELECT action, docstatus_from, docstatus_to FROM audit_log WHERE entity_id = ? ORDER BY rowid`,
      [draft.billId],
    )
    expect(rows.map((r) => r.action)).toEqual(['create', 'submit', 'cancel'])
    expect(rows[1]).toMatchObject({ docstatus_from: DRAFT, docstatus_to: SUBMITTED })
    expect(rows[2]).toMatchObject({ docstatus_from: SUBMITTED, docstatus_to: CANCELLED })
  })
})

describe('paying with loyalty points', () => {
  async function withProgram(fraction = 10_000) {
    await setSetting(fx.db, 'loyalty_program', JSON.stringify({
      enabled: true,
      tiers: [{ minSpend: 0, pointsPerHundred: 10 }],
      expiryDays: null,
      pointValue: rupees(1),
      earnOnCreditPortion: true,
      minBillForEarn: 0,
      maxRedeemFractionBp: fraction,
    }))
  }

  async function givePoints(customerId: string, points: number) {
    await fx.db.execute(
      `INSERT INTO loyalty_entries (id, customer_id, bill_id, points, consumed, earned_at, created_at)
       VALUES (?, ?, NULL, ?, 0, ?, ?)`,
      [newId(), customerId, points, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    )
  }

  /* The counter can now settle a bill entirely with points, which sends no
     payment rows at all — the redemption has to satisfy the total on its own. */
  it('settles a bill with points alone, taking no tender', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)
    const customerId = await makeCustomer(fx.db)
    await withProgram()
    await givePoints(customerId, 500)

    const draft = await billFor(p, 2, customerId)
    if (!draft.ok) throw new Error('draft failed')
    expect(draft.grandTotal).toBe(rupees(200))

    const done = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [],
      redeemPoints: 200,
      actorId: fx.adminId,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return

    expect(done.pointsRedeemed).toBe(200)

    // The redemption is itself the tender, recorded as such rather than as cash.
    const tenders = await fx.db.query<{ method: string; amount: number; reference: string | null }>(
      `SELECT method, amount, reference FROM bill_payments WHERE bill_id = ?`, [draft.billId],
    )
    expect(tenders).toHaveLength(1)
    expect(tenders[0]!.method).toBe('loyalty')
    expect(tenders[0]!.amount).toBe(rupees(200))
    expect(tenders[0]!.reference).toBe('200 points')

    const bill = await fx.db.get<{ paid_total: number; credit_total: number }>(
      `SELECT paid_total, credit_total FROM bills WHERE id = ?`, [draft.billId],
    )
    expect(bill?.credit_total).toBe(0)
  })

  it('takes the rest in cash when points cover only part', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)
    const customerId = await makeCustomer(fx.db)
    await withProgram()
    await givePoints(customerId, 50)

    const draft = await billFor(p, 2, customerId)
    if (!draft.ok) throw new Error('draft failed')

    const done = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: rupees(150) }],
      redeemPoints: 50,
      actorId: fx.adminId,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.pointsRedeemed).toBe(50)
  })

  it('refuses a payment that does not add up once points are counted', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)
    const customerId = await makeCustomer(fx.db)
    await withProgram()
    await givePoints(customerId, 50)

    const draft = await billFor(p, 2, customerId)
    if (!draft.ok) throw new Error('draft failed')

    const done = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: rupees(200) }],
      redeemPoints: 50,
      actorId: fx.adminId,
    })
    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.code).toBe('PAYMENT_MISMATCH')
  })
})

/* Recharge vouchers, cigarettes, milk, cooking gas: sold at a few rupees a unit
   because the shop must stock them, not because they make money. A discount or
   a loyalty payout across the whole bill turns those lines into a loss, so the
   exclusion sits on the item and holds regardless of who writes the rule. */
describe('items that carry no margin to give away', () => {
  it('refuses a discount typed against a blocked line', async () => {
    const p = await makeProduct(fx.db, { name: 'Mobile recharge', baseRate: rupees(100), taxRateBp: 0, discountBlocked: true })
    await stockUp(fx.db, p, 10)

    const r = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1), discount: rupees(10) }],
      actorId: fx.adminId,
    })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('DISCOUNT_BLOCKED')
  })

  it('keeps a bill discount off the blocked line', async () => {
    const open = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    const thin = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0, discountBlocked: true })
    await stockUp(fx.db, open, 10)
    await stockUp(fx.db, thin, 10)

    const r = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: open, qty: fromUnits(1) }, { productId: thin, qty: fromUnits(1) }],
      billDiscount: rupees(20),
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grandTotal).toBe(rupees(180))

    const rows = await fx.db.query<{ discount: number; line_total: number; discount_blocked: number }>(
      `SELECT discount, line_total, discount_blocked FROM bill_items WHERE bill_id = ? ORDER BY idx`,
      [r.billId],
    )
    expect(rows[0]).toMatchObject({ discount: rupees(20), discount_blocked: 0 })
    expect(rows[1]).toMatchObject({ discount: 0, line_total: rupees(100), discount_blocked: 1 })
  })

  it('refuses a bill discount larger than the part that may carry it', async () => {
    const open = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    const thin = await makeProduct(fx.db, { baseRate: rupees(900), taxRateBp: 0, discountBlocked: true })
    await stockUp(fx.db, open, 10)
    await stockUp(fx.db, thin, 10)

    const r = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: open, qty: fromUnits(1) }, { productId: thin, qty: fromUnits(1) }],
      billDiscount: rupees(500),
      actorId: fx.adminId,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    if (r.code !== 'DISCOUNT_EXCEEDS_TOTAL') throw new Error(r.code)
    // Reported against the discountable part, so the message can say what is
    // actually available.
    expect(r.subtotal).toBe(rupees(100))
  })

  it('earns no points on a line excluded from the programme', async () => {
    await setSetting(fx.db, 'loyalty_program', JSON.stringify({
      enabled: true,
      tiers: [{ minSpend: 0, pointsPerHundred: 10 }],
      expiryDays: null,
      pointValue: rupees(1),
      earnOnCreditPortion: true,
      minBillForEarn: 0,
      maxRedeemFractionBp: 10_000,
    }))

    const open = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    const thin = await makeProduct(fx.db, { baseRate: rupees(900), taxRateBp: 0, loyaltyBlocked: true })
    await stockUp(fx.db, open, 10)
    await stockUp(fx.db, thin, 10)
    const customerId = await makeCustomer(fx.db)

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId,
      lines: [{ productId: open, qty: fromUnits(1) }, { productId: thin, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    expect(draft.grandTotal).toBe(rupees(1000))

    const done = await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: rupees(1000) }],
      actorId: fx.adminId,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    // Ten points per hundred, on ₹100 rather than on ₹1,000.
    expect(done.pointsEarned).toBe(10)
  })

  /* The flag can be changed later; the bill must still explain itself. */
  it('stamps the exclusions onto the line as they stood at the time of sale', async () => {
    const thin = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0, discountBlocked: true, loyaltyBlocked: true })
    await stockUp(fx.db, thin, 10)

    const r = await billFor(thin, 1)
    if (!r.ok) throw new Error('draft failed')
    await fx.db.execute(`UPDATE products SET discount_blocked = 0, loyalty_blocked = 0 WHERE id = ?`, [thin])

    const row = await fx.db.get<{ discount_blocked: number; loyalty_blocked: number }>(
      `SELECT discount_blocked, loyalty_blocked FROM bill_items WHERE bill_id = ?`, [r.billId],
    )
    expect(row).toMatchObject({ discount_blocked: 1, loyalty_blocked: 1 })
  })
})
