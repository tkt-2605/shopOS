import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, RULE_46F_THRESHOLD } from '../src/services/billing.js'
import { saveShopProfile, loadShopProfile } from '../src/services/shop.js'
import { setTaxScheme } from '../src/services/features.js'
import { setSetting } from '../src/services/bootstrap.js'
import { gstExceptions } from '../src/repos/reports.js'
import { hsnProblem, isHsn, HSN_SHAPE } from '../src/domain/hsn.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * The guards, and the line every one of them walks.
 *
 * A guard on a till is a decision about whose afternoon is ruined. Refuse too
 * eagerly and a cashier cannot sell the thing in the customer's hand, which is
 * the one failure this product is not allowed to have. Refuse too little and
 * the shop finds out from its own return, months later, with the money already
 * spent.
 *
 * So each of these is tied to a rule that actually applies, fires as late as it
 * can, and says what to do about it. The two that refuse do it at submit and
 * never while a cart is being built. The two that warn never refuse at all.
 *
 * All four were checked against the owner's real database before they were
 * written: `shop_state_code` is set, the largest bill in its history is
 * ₹17,680, and all twenty products carry a four-digit HSN. Not one of them
 * fires on that shop today, which is the point of having looked.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function ring(opts: { rupeesEach: number; customerId?: string }): Promise<string> {
  const productId = await makeProduct(fx.db, {
    name: 'Paper', baseRate: rupees(opts.rupeesEach), taxRateBp: 1800,
  })
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    lines: [{ productId, qty: fromUnits(1) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  return draft.billId
}

async function pay(billId: string) {
  const row = await fx.db.get<{ grand_total: number }>(
    `SELECT grand_total FROM bills WHERE id = ?`, [billId])
  return submitBill(fx.db, {
    billId, actorId: fx.adminId,
    payments: [{ method: 'cash', amount: row!.grand_total as Money }],
  })
}

describe('a shop that has not said which state it is in', () => {
  it('is refused at submit, because every bill it raises is taxed wrong', async () => {
    await setSetting(fx.db, 'shop_state_code', '')

    /* `supplyTypeFor(null, anything)` answers `intra_state`, so with no shop
       state every sale is CGST+SGST — including one to a customer in another
       state, where the law says IGST. There is no honest value to correct it
       to, so it is refused rather than guessed at. */
    expect(await pay(await ring({ rupeesEach: 100 }))).toEqual({ ok: false, code: 'SHOP_STATE_UNSET' })
  })

  it('lets the cart be built anyway, which is the whole difference', async () => {
    await setSetting(fx.db, 'shop_state_code', '')

    /* A cashier scanning items must never be stopped halfway by a settings
       problem they cannot fix with a customer in front of them. The guard bites
       when the document is issued, which is when it starts to matter. */
    const billId = await ring({ rupeesEach: 100 })
    expect(billId).toBeTruthy()
  })

  it('says nothing to a shop that does not charge tax, which does not need a state', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'unregistered')
    await setSetting(fx.db, 'shop_state_code', '')

    // No tax means no CGST-against-IGST question, so the setting decides
    // nothing and a guard over it would stop a till for no reason at all.
    const done = await pay(await ring({ rupeesEach: 100 }))
    expect(done.ok).toBe(true)
  })

  it('refuses a state that is not a state, not only an empty one', async () => {
    await setSetting(fx.db, 'shop_state_code', '99')
    expect(await pay(await ring({ rupeesEach: 100 }))).toEqual({ ok: false, code: 'SHOP_STATE_UNSET' })
  })
})

describe('Rule 46(f): fifty thousand rupees with nobody named on it', () => {
  it('is refused, and says by how much it is over', async () => {
    const result = await pay(await ring({ rupeesEach: 60_000 }))

    expect(result).toEqual({
      ok: false,
      code: 'NEEDS_RECIPIENT',
      grandTotal: rupees(60_000),
      threshold: RULE_46F_THRESHOLD,
    })
    expect(RULE_46F_THRESHOLD).toBe(rupees(50_000))
  })

  it('goes through the moment a customer is on it', async () => {
    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')
    const done = await pay(await ring({ rupeesEach: 60_000, customerId }))
    expect(done.ok).toBe(true)
  })

  it('leaves an ordinary counter sale alone', async () => {
    // The largest bill in the owner's entire history is ₹17,680. This guard has
    // never fired on that shop and is not meant to.
    const done = await pay(await ring({ rupeesEach: 17_680 }))
    expect(done.ok).toBe(true)
  })

  it('fires exactly at the threshold and not a paisa below', async () => {
    const under = await pay(await ring({ rupeesEach: 49_999 }))
    expect(under.ok).toBe(true)

    const at = await pay(await ring({ rupeesEach: 50_000 }))
    expect(at.ok).toBe(false)
  })

  it('says nothing on a bill of supply, which carries no such rule', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'composition')

    /* Rule 46(f) is about a tax invoice. Rule 49's bill of supply has no
       threshold in it, and a guard with no rule behind it is a guard that stops
       a shop for nothing. */
    const done = await pay(await ring({ rupeesEach: 60_000 }))
    expect(done.ok).toBe(true)
  })
})

describe('a registered shop with no GSTIN of its own', () => {
  async function save(gstin: string | null) {
    const profile = await loadShopProfile(fx.db)
    return saveShopProfile(fx.db, { actorId: fx.adminId }, { ...profile, gstin })
  }

  it('cannot save itself once it has said it is registered', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'regular')
    // Rule 46(a): the supplier's registration number is on every tax invoice,
    // and this shop has said it prints them.
    expect(await save(null)).toEqual({ ok: false, code: 'GSTIN_REQUIRED' })
  })

  it('saves once the number is entered', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'regular')
    expect(await save('33ALNPJ1906G1ZC')).toEqual({ ok: true })
  })

  it('never bites on the till_s own guess, only on an answer', async () => {
    /* The case that would have locked the owner out. A shop that has been
       trading is *assumed* regular from the tax on its bills, and until
       `services/shop.ts` existed there was no screen in this product that could
       save a GSTIN — so that shop has none through no fault of its own.
       Refusing it here would refuse the one form that lets them answer. */
    expect(await save(null)).toEqual({ ok: true })
  })

  it('lets a composition or unregistered shop save without one', async () => {
    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'composition')
    expect(await save(null)).toEqual({ ok: true })

    await setTaxScheme(fx.db, { actorId: fx.adminId }, 'unregistered')
    expect(await save(null)).toEqual({ ok: true })
  })
})

describe('an HSN code that is not the shape of one', () => {
  it('accepts the three lengths the schedule is published at', () => {
    for (const code of ['4802', '480210', '48021000']) {
      expect(isHsn(code), code).toBe(true)
      expect(hsnProblem(code), code).toBeNull()
    }
  })

  it('warns about anything else', () => {
    // Five and seven digits are not truncations of anything; they are typos.
    for (const code of ['480', '48021', '4802100', '480210000', '4802-10', 'ABCD']) {
      expect(hsnProblem(code), code).toBe('HSN_SHAPE')
    }
  })

  it('says nothing about a blank one, which is honest', () => {
    /* Plenty of shops have never been asked for a code. Absence becomes worth
       saying in the GST export, and only on a line billed to a registered
       buyer — not on a form somebody is in the middle of filling in. */
    expect(hsnProblem('')).toBeNull()
    expect(hsnProblem('   ')).toBeNull()
    expect(hsnProblem(null)).toBeNull()
    expect(hsnProblem(undefined)).toBeNull()
  })

  it('checks the shape and deliberately not the meaning', () => {
    // Whether 4820 is the right chapter for a notebook is a question for the
    // schedule, and software guessing at it would be confidently wrong.
    expect(HSN_SHAPE.test('0000')).toBe(true)
  })
})

describe('the exceptions the GST export carries', () => {
  const ALL = { from: '0000-01-01', to: '9999-12-31' }

  async function sellTo(customerId: string | null, hsn: string | null) {
    const productId = await makeProduct(fx.db, { name: 'Gum', baseRate: rupees(100), taxRateBp: 1800 })
    await fx.db.execute(`UPDATE products SET hsn_code = ? WHERE id = ?`, [hsn, productId])

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      ...(customerId ? { customerId } : {}),
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await pay(draft.billId)
  }

  it('lists a line billed to a registered buyer with no HSN', async () => {
    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')
    await fx.db.execute(`UPDATE customers SET gstin = '33AAACS1234F1Z5' WHERE id = ?`, [customerId])
    await sellTo(customerId, null)

    const rows = await gstExceptions(fx.db, ALL)
    expect(rows).toHaveLength(1)
    // The invoice number and the item name, because "14 lines are missing HSN"
    // is a number nobody can act on.
    expect(rows[0]).toMatchObject({ productName: 'Gum', gstin: '33AAACS1234F1Z5' })
    expect(rows[0]!.docNo).toBeTruthy()
    expect(rows[0]!.problem).toContain('HSN')
  })

  it('leaves a walk-in out, whose missing code harms nobody', async () => {
    await sellTo(null, null)
    /* A sheet that listed every untidy counter line would bury the ones that
       matter — the lines a registered buyer is claiming input credit on. */
    expect(await gstExceptions(fx.db, ALL)).toEqual([])
  })

  it('leaves a B2B line alone once it has a code', async () => {
    const customerId = await makeCustomer(fx.db, 'Ramesh Traders')
    await fx.db.execute(`UPDATE customers SET gstin = '33AABCR5678G1Z2' WHERE id = ?`, [customerId])
    await sellTo(customerId, '4802')

    expect(await gstExceptions(fx.db, ALL)).toEqual([])
  })

  it('reads the GSTIN off the bill, not off the customer as they are today', async () => {
    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')
    await fx.db.execute(`UPDATE customers SET gstin = '33AAACS1234F1Z5' WHERE id = ?`, [customerId])
    await sellTo(customerId, null)

    // The customer deregisters. The invoice was still issued to a registered
    // buyer, and the line is still an exception on the return it went into.
    await fx.db.execute(`UPDATE customers SET gstin = NULL WHERE id = ?`, [customerId])
    expect(await gstExceptions(fx.db, ALL)).toHaveLength(1)
  })
})
