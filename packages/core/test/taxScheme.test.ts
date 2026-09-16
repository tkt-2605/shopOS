import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  TAX_SCHEMES, chargesTax, defaultScheme, documentTitle, schemeStatement, billWording,
  COMPOSITION_STATEMENT, isTaxScheme,
} from '../src/domain/taxScheme.js'
import { loadTaxScheme, setTaxScheme, taxSchemeAnswered } from '../src/services/features.js'
import { setSetting } from '../src/services/bootstrap.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { taxByRate } from '../src/repos/reports.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * A shop that does not collect GST, and has been collecting it anyway.
 *
 * This product charged CGST and SGST on every line of every bill since v1, with
 * no way to say that the shop is not entitled to. Two kinds of shop it is sold
 * to are not: a composition dealer, who pays a flat percentage out of their own
 * pocket and is forbidden by Section 10 from collecting tax on supplies, and a
 * shop that is not registered at all.
 *
 * Both have been handing customers a document headed "Tax Invoice" showing tax
 * they may not charge. Collecting tax without being entitled to is an offence in
 * itself, and the customer has been claiming input credit on it.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('what each scheme means', () => {
  it('charges tax under the regular scheme and under no other', () => {
    expect(chargesTax('regular')).toBe(true)
    expect(chargesTax('composition')).toBe(false)
    expect(chargesTax('unregistered')).toBe(false)
  })

  it('titles the document the way the rules title it', () => {
    expect(documentTitle('regular')).toBe('Tax Invoice')
    // Rule 49. Not "Invoice", and emphatically not "Tax Invoice".
    expect(documentTitle('composition')).toBe('Bill of Supply')
    expect(documentTitle('unregistered')).toBe('Invoice')
  })

  it('carries the Rule 49 sentence for a composition dealer, in the rule_s words', () => {
    expect(schemeStatement('composition')).toBe(COMPOSITION_STATEMENT)
    expect(COMPOSITION_STATEMENT).toContain('not eligible to collect tax on supplies')
    // Nobody else owes a statement, and one that appears where it is not owed
    // is a claim about the shop that is not true.
    expect(schemeStatement('regular')).toBeNull()
    expect(schemeStatement('unregistered')).toBeNull()
  })

  it('changes the title and nothing else about the wording', () => {
    const regular = billWording('regular')
    const composition = billWording('composition')
    expect(composition.title).toBe('Bill of Supply')
    // A bill of supply is still billed to somebody and still has a number.
    expect(composition.docNo).toBe(regular.docNo)
    expect(composition.party).toBe(regular.party)
  })

  it('recognises its own three and refuses anything else', () => {
    for (const scheme of TAX_SCHEMES) expect(isTaxScheme(scheme)).toBe(true)
    for (const not of ['', 'Regular', 'gst', null, undefined]) {
      expect(isTaxScheme(not), String(not)).toBe(false)
    }
  })
})

describe('what a shop that has never been asked is assumed to be', () => {
  it('is regular when it has a GSTIN, because that is a registration', () => {
    expect(defaultScheme('33ALNPJ1906G1ZC')).toBe('regular')
  })

  it('says nothing useful when it has none, which is the point', () => {
    /* This half of the question answers "no" and the rest of the evidence is
       weighed in `loadTaxScheme`. An empty GSTIN is as likely to mean that no
       screen in this product could save one -- which was true until
       `services/shop.ts` was written -- as to mean the shop is not registered. */
    expect(defaultScheme(null)).toBe('unregistered')
    expect(defaultScheme('')).toBe('unregistered')
    expect(defaultScheme('   ')).toBe('unregistered')
  })

  it('keeps deriving until somebody answers, rather than being written in once', async () => {
    await setSetting(fx.db, 'shop_gstin', '')
    expect(await loadTaxScheme(fx.db)).toBe('unregistered')
    expect(await taxSchemeAnswered(fx.db)).toBe(false)

    // A shop that enters its registration a week later stops being treated as
    // unregistered without anybody having to remember this setting exists.
    await setSetting(fx.db, 'shop_gstin', '33ALNPJ1906G1ZC')
    expect(await loadTaxScheme(fx.db)).toBe('regular')
    expect(await taxSchemeAnswered(fx.db)).toBe(false)
  })

  it('leaves a shop that has been charging tax charging it, GSTIN or not', async () => {
    /* The case that matters, and the owner's own database: 29 submitted bills,
       every one carrying CGST and SGST, and `shop_gstin` empty -- because until
       `services/shop.ts` existed there was no screen in this product that could
       save one. Reading that empty field as "not registered" would switch a
       properly registered shop's tax off on upgrade, and it would owe output
       tax on every sale it made afterwards out of its own takings. */
    const productId = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
    })

    await setSetting(fx.db, 'shop_gstin', '')

    expect(await loadTaxScheme(fx.db)).toBe('regular')
    // And it is still a guess, so Settings still asks.
    expect(await taxSchemeAnswered(fx.db)).toBe(false)
  })

  it('does not start a brand new till charging tax nobody asked it to', async () => {
    await setSetting(fx.db, 'shop_gstin', '')
    // Nothing billed, so there is nothing to preserve, and the safe reading is
    // the one that does not collect tax in a shop's name without being told.
    expect(await loadTaxScheme(fx.db)).toBe('unregistered')
  })

  it('ignores a draft and a cancelled bill, which charged nobody anything', async () => {
    await setSetting(fx.db, 'shop_gstin', '')
    const productId = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })

    // A draft: never issued.
    await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    expect(await loadTaxScheme(fx.db)).toBe('unregistered')

    // And one that was issued and taken back. Neither is evidence of a shop
    // that has been operating as a registered one.
    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!made.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    await cancelBill(fx.db, { billId: made.billId, actorId: fx.adminId, reason: 'x' })
    expect(await loadTaxScheme(fx.db)).toBe('unregistered')
  })

  it('stops deriving the moment a person says', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'composition')
    expect(await taxSchemeAnswered(fx.db)).toBe(true)
    expect(await loadTaxScheme(fx.db)).toBe('composition')

    // And the GSTIN no longer decides it. A composition dealer has one.
    await setSetting(fx.db, 'shop_gstin', '33ALNPJ1906G1ZC')
    expect(await loadTaxScheme(fx.db)).toBe('composition')
  })

  it('records the answer even when it agrees with what was assumed', async () => {
    // Answering is the change: it is what stops the till asking.
    expect(await loadTaxScheme(fx.db)).toBe('regular')
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'regular')

    expect(await taxSchemeAnswered(fx.db)).toBe(true)
    const audit = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity_id = 'shop_tax_scheme'`)
    expect(audit?.diff).toContain('assumed')
  })
})

describe('what the till charges', () => {
  async function sell(): Promise<{ billId: string; grandTotal: number }> {
    const productId = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(118), taxRateBp: 1800 })
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
    })
    return { billId: draft.billId, grandTotal: draft.grandTotal }
  }

  it('charges nothing at all under composition', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'composition')
    const { billId, grandTotal } = await sell()

    const bill = await fx.db.get<{ taxable_total: number; tax_total: number }>(
      `SELECT taxable_total, tax_total FROM bills WHERE id = ?`, [billId])

    /* The customer pays the same ₹118 — the shelf price is the shelf price —
       and the whole of it is the value of the goods rather than ₹100 of goods
       and ₹18 of tax the shop may not collect. */
    expect(grandTotal).toBe(rupees(118))
    expect(bill?.taxable_total).toBe(rupees(118))
    expect(bill?.tax_total).toBe(0)

    const line = await fx.db.get<{ cgst_amount: number; sgst_amount: number; tax_rate_bp: number }>(
      `SELECT cgst_amount, sgst_amount, tax_rate_bp FROM bill_items WHERE bill_id = ?`, [billId])
    expect(line).toMatchObject({ cgst_amount: 0, sgst_amount: 0, tax_rate_bp: 0 })
  })

  it('charges nothing under no registration either', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'unregistered')
    const { billId } = await sell()
    const bill = await fx.db.get<{ tax_total: number }>(
      `SELECT tax_total FROM bills WHERE id = ?`, [billId])
    expect(bill?.tax_total).toBe(0)
  })

  it('leaves the product_s own rate alone, for the day the shop registers', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'composition')
    const productId = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(118), taxRateBp: 1800 })

    await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })

    /* A shop that registers next year must not have to re-enter the rate on
       nine hundred products. The rate is a fact about the goods; whether it is
       charged is a fact about the shop. */
    const product = await fx.db.get<{ tax_rate_bp: number }>(
      `SELECT tax_rate_bp FROM products WHERE id = ?`, [productId])
    expect(product?.tax_rate_bp).toBe(1800)
  })

  it('starts charging again the day the shop registers, without touching anything else', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'unregistered')
    await sell()
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'regular')
    const { billId } = await sell()

    const bill = await fx.db.get<{ tax_total: number }>(
      `SELECT tax_total FROM bills WHERE id = ?`, [billId])
    expect(bill?.tax_total).toBeGreaterThan(0)
  })

  it('leaves bills already raised exactly as they were', async () => {
    const { billId } = await sell()
    const before = await fx.db.get<{ tax_total: number }>(
      `SELECT tax_total FROM bills WHERE id = ?`, [billId])
    expect(before?.tax_total).toBeGreaterThan(0)

    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'composition')

    /* Nothing here is retrospective. Those bills were issued, the customer holds
       a copy, and the tax on them has been collected and declared. */
    const after = await fx.db.get<{ tax_total: number }>(
      `SELECT tax_total FROM bills WHERE id = ?`, [billId])
    expect(after?.tax_total).toBe(before?.tax_total)
  })

  it('reports a nil rate rather than disappearing out of the GST export', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'composition')
    await sell()

    const rows = await taxByRate(fx.db, { from: '0000-01-01', to: '9999-12-31' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rateBp: 0, cgst: 0, sgst: 0, igst: 0 })
    // The goods still have a value, and a composition dealer still files on it.
    expect(rows[0]!.taxable).toBe(rupees(118))
  })
})
