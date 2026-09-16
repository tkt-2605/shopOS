import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GSTIN_SHAPE, isGstin, resolveCustomerState, stateFromGstin } from '../src/domain/gstin.js'
import { isStateCode, stateName, STATES } from '../src/domain/states.js'
import { supplyTypeFor } from '../src/domain/tax.js'
import { createCustomer, updateCustomer } from '../src/services/customers.js'
import { setSetting, getSetting } from '../src/services/bootstrap.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Which state a customer is in, which is the whole of CGST+SGST against IGST.
 *
 * Every `customers.state_code` in the owner's database was the literal `'33'`
 * that `customers.ts` wrote into its INSERT -- a SQL literal, never a
 * parameter, so no person had ever entered one. The field that decides which
 * tax a bill charges was a constant, and it was invisible because the shop is
 * itself in state 33: the fabrication and the truth coincided, every bill came
 * out intra-state, and every bill was right by accident.
 *
 * It would have gone wrong on the first sale to a customer in another state,
 * which for a stationery shop is a school one district over. The bill would
 * have charged CGST+SGST where IGST was owed, and the shop would have found out
 * from its own return.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const TN = '33AAACS1234F1Z5'
const MAHARASHTRA = '27AABCR5678G1Z2'

describe('reading a state off a GSTIN', () => {
  it('takes the first two characters when they name a state', () => {
    expect(stateFromGstin(TN)).toBe('33')
    expect(stateFromGstin(MAHARASHTRA)).toBe('27')
  })

  it('answers null rather than guessing at something that is not a GSTIN', () => {
    /* A half-typed number passes through here on its way to being finished, and
       a caller that took the first two characters unconditionally would write
       `27` into a place-of-supply field off `27AAB` and print it. */
    for (const not of [null, undefined, '', '27', '27AAB', 'not a gstin', '33AAACS1234F1Z']) {
      expect(stateFromGstin(not), String(not)).toBeNull()
    }
  })

  it('answers null for two digits that are not a state anybody is registered in', () => {
    // 00 and 99 are neither. They would otherwise reach an invoice.
    expect(stateFromGstin('00AAACS1234F1Z5')).toBeNull()
    expect(stateFromGstin('99AAACS1234F1Z5')).toBeNull()
  })

  it('checks the shape and deliberately not the checksum', () => {
    // A checksum rule that rejected a number the government issued would be the
    // software telling the shop its registration is wrong.
    expect(isGstin(TN)).toBe(true)
    expect(GSTIN_SHAPE.test('33AAACS1234F1ZZ')).toBe(true)
    expect(isGstin('33aaacs1234f1z5')).toBe(false)
  })
})

describe('the order the state is decided in', () => {
  it('lets the GSTIN outrank everything, because it is the registered fact', () => {
    const state = resolveCustomerState({
      gstin: MAHARASHTRA, chosen: '33', shopState: '33',
    })
    expect(state).toBe('27')
  })

  it('takes an explicit choice when there is no GSTIN', () => {
    expect(resolveCustomerState({ gstin: null, chosen: '29', shopState: '33' })).toBe('29')
  })

  it("falls back to the shop's own state for a walk-in", () => {
    // Right far more often than it is wrong in a counter shop, and the
    // alternative reads as "unknown place of supply" on the invoice.
    expect(resolveCustomerState({ shopState: '33' })).toBe('33')
  })

  it('says nothing when nobody has said anything', () => {
    expect(resolveCustomerState({})).toBeNull()
    expect(resolveCustomerState({ chosen: '99', shopState: 'nonsense' })).toBeNull()
  })
})

describe('a customer being entered', () => {
  it('no longer records everybody as being in Tamil Nadu', async () => {
    await setSetting(fx.db, 'shop_state_code', '27')

    const made = await createCustomer(fx.db, { actorId: fx.adminId }, { name: 'Walk-in' })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const row = await fx.db.get<{ state_code: string | null }>(
      `SELECT state_code FROM customers WHERE id = ?`, [made.customerId])
    expect(row?.state_code).toBe('27')
  })

  it('takes the state from the GSTIN even when the shop is elsewhere', async () => {
    await setSetting(fx.db, 'shop_state_code', '33')

    const made = await createCustomer(fx.db, { actorId: fx.adminId },
      { name: 'Ramesh Traders', gstin: MAHARASHTRA })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const row = await fx.db.get<{ state_code: string | null; gstin: string }>(
      `SELECT state_code, gstin FROM customers WHERE id = ?`, [made.customerId])

    /* This is the sale the old code got wrong: a Maharashtra customer billed by
       a Tamil Nadu shop owes IGST, and the fabricated '33' made it CGST+SGST. */
    expect(row?.state_code).toBe('27')
    expect(supplyTypeFor(await getSetting(fx.db, 'shop_state_code'), row!.state_code))
      .toBe('inter_state')
  })

  it('refuses a GSTIN that is not one, rather than storing it', async () => {
    const made = await createCustomer(fx.db, { actorId: fx.adminId },
      { name: 'Typo', gstin: '33AAACS1234' })
    expect(made).toEqual({ ok: false, code: 'BAD_GSTIN' })
  })

  it('refuses a state nobody is registered in', async () => {
    const made = await createCustomer(fx.db, { actorId: fx.adminId },
      { name: 'Nowhere', stateCode: '99' })
    expect(made).toEqual({ ok: false, code: 'UNKNOWN_STATE' })
  })

  it('refuses a GSTIN and a state that disagree', async () => {
    // At the counter it is a typo. At filing time it is a correction.
    const made = await createCustomer(fx.db, { actorId: fx.adminId },
      { name: 'Mismatch', gstin: MAHARASHTRA, stateCode: '33' })
    expect(made).toEqual({
      ok: false, code: 'GSTIN_STATE_MISMATCH', gstinState: '27', chosenState: '33',
    })
  })

  it('moves the state when the GSTIN is corrected later', async () => {
    await setSetting(fx.db, 'shop_state_code', '33')
    const made = await createCustomer(fx.db, { actorId: fx.adminId }, { name: 'Sri Vidya' })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    /* The update path never touched state_code at all, so a customer corrected
       to carry a Maharashtra GSTIN kept the Tamil Nadu default for ever. */
    await updateCustomer(fx.db, { actorId: fx.adminId }, made.customerId,
      { name: 'Sri Vidya', gstin: MAHARASHTRA })

    const row = await fx.db.get<{ state_code: string | null }>(
      `SELECT state_code FROM customers WHERE id = ?`, [made.customerId])
    expect(row?.state_code).toBe('27')
  })

  it('records the state it settled on in the audit row', async () => {
    await setSetting(fx.db, 'shop_state_code', '33')
    const made = await createCustomer(fx.db, { actorId: fx.adminId },
      { name: 'Audited', gstin: MAHARASHTRA })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const audit = await fx.db.get<{ diff: string | null }>(
      `SELECT diff FROM audit_log WHERE entity = 'customers' AND entity_id = ?`,
      [made.customerId])
    expect(audit?.diff).toContain('27')
  })
})

describe('the list of states itself', () => {
  it('has every code a GSTIN can begin with', () => {
    expect(STATES).toHaveLength(37)
    expect(new Set(STATES.map((s) => s.code)).size).toBe(37)
  })

  it('names them, because a shop should pick a state and never meet the number', () => {
    expect(stateName('33')).toBe('Tamil Nadu')
    expect(stateName('27')).toBe('Maharashtra')
    expect(stateName('99')).toBeNull()
    expect(stateName(null)).toBeNull()
    expect(STATES.every((s) => s.name.trim() !== '')).toBe(true)
  })

  it('agrees with isStateCode', () => {
    for (const s of STATES) expect(isStateCode(s.code), s.code).toBe(true)
    for (const not of ['00', '99', '3', '333', '', null, undefined]) {
      expect(isStateCode(not), String(not)).toBe(false)
    }
  })
})
