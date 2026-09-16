import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadShopProfile, saveShopProfile, stateName, type ShopProfile } from '../src/services/shop.js'
import { getSetting } from '../src/services/bootstrap.js'
import { supplyTypeFor } from '../src/domain/tax.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Who the shop is, on paper.
 *
 * The theme of this file is that these nine fields were readable and unwritable
 * for the whole life of the product, and one of them — the state code — silently
 * decided the tax on every bill.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

const BLANK: ShopProfile = {
  name: 'Sri Stores',
  address: null, phone: null, email: null, gstin: null, stateCode: null,
  receiptFooter: null, terms: null, logo: null,
}

describe('the shop profile', () => {
  it('keeps the name bootstrap wrote until something changes it', async () => {
    expect((await loadShopProfile(fx.db)).name).toBe('Test Shop')
  })

  it('saves the address the receipt has always tried to print', async () => {
    const result = await saveShopProfile(fx.db, ctx(), {
      ...BLANK, address: '12 Bazaar Street, Coimbatore', phone: '9876543210',
    })

    expect(result.ok).toBe(true)
    const saved = await loadShopProfile(fx.db)
    expect(saved.address).toBe('12 Bazaar Street, Coimbatore')
    expect(saved.phone).toBe('9876543210')
  })

  it('refuses a shop with no name at all', async () => {
    const result = await saveShopProfile(fx.db, ctx(), { ...BLANK, name: '   ' })
    expect(result).toEqual({ ok: false, code: 'NAME_REQUIRED' })
  })

  it('empties a field back to nothing rather than to an empty string', async () => {
    await saveShopProfile(fx.db, ctx(), { ...BLANK, phone: '9876543210' })
    await saveShopProfile(fx.db, ctx(), { ...BLANK, phone: '' })

    expect((await loadShopProfile(fx.db)).phone).toBeNull()
  })

  it('refuses something that is not the shape of a GSTIN', async () => {
    const result = await saveShopProfile(fx.db, ctx(), { ...BLANK, gstin: '33ABCDE' })
    expect(result).toEqual({ ok: false, code: 'BAD_GSTIN' })
  })

  it('refuses a GSTIN that contradicts the state chosen', async () => {
    const result = await saveShopProfile(fx.db, ctx(), {
      ...BLANK, gstin: '33ABCDE1234F1Z5', stateCode: '32',
    })

    expect(result).toEqual({
      ok: false, code: 'GSTIN_STATE_MISMATCH', gstinState: '33', chosenState: '32',
    })
  })

  it('accepts a GSTIN that agrees with the state chosen', async () => {
    const result = await saveShopProfile(fx.db, ctx(), {
      ...BLANK, gstin: '33ABCDE1234F1Z5', stateCode: '33',
    })

    expect(result.ok).toBe(true)
    expect((await loadShopProfile(fx.db)).gstin).toBe('33ABCDE1234F1Z5')
  })

  it('takes a GSTIN typed in lower case', async () => {
    const result = await saveShopProfile(fx.db, ctx(), { ...BLANK, gstin: '33abcde1234f1z5' })

    expect(result.ok).toBe(true)
    expect((await loadShopProfile(fx.db)).gstin).toBe('33ABCDE1234F1Z5')
  })

  it('refuses a state code that is not a state', async () => {
    const result = await saveShopProfile(fx.db, ctx(), { ...BLANK, stateCode: '99' })
    expect(result).toEqual({ ok: false, code: 'UNKNOWN_STATE' })
  })

  it('writes the state code that decides the tax on every bill', async () => {
    await saveShopProfile(fx.db, ctx(), { ...BLANK, stateCode: '33' })
    expect(await getSetting(fx.db, 'shop_state_code')).toBe('33')
  })

  it('records who changed the shop details, and what moved', async () => {
    await saveShopProfile(fx.db, ctx(), { ...BLANK, gstin: '33ABCDE1234F1Z5' })

    const row = await fx.db.get<{ actor_id: string; diff: string }>(
      `SELECT actor_id, diff FROM audit_log WHERE entity = 'settings' AND entity_id = 'shop_profile'`,
    )

    expect(row?.actor_id).toBe(fx.adminId)
    // The fixture is a registered shop, so this is a correction rather than a
    // first entry — and "the GSTIN on our invoices changed and nobody touched
    // it" is exactly the question this row exists to answer.
    expect(JSON.parse(row!.diff)['gstin'])
      .toEqual({ from: '33ALNPJ1906G1ZC', to: '33ABCDE1234F1Z5' })
  })

  it('leaves the fields nobody touched out of the history', async () => {
    await saveShopProfile(fx.db, ctx(), { ...BLANK, phone: '9876543210' })

    const row = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity_id = 'shop_profile'`,
    )

    /* `name` moved too — from 'Test Shop' to 'Sri Stores' — and `gstin` and
       `stateCode` are cleared, because BLANK carries neither and the fixture is
       a registered shop in a state. The four fields that were null and stayed
       null must not be in there, or the history becomes a dump. */
    expect(Object.keys(JSON.parse(row!.diff)).sort())
      .toEqual(['gstin', 'name', 'phone', 'stateCode'])
  })

  it('names the state a code belongs to, because nobody knows 33 by heart', () => {
    expect(stateName('33')).toBe('Tamil Nadu')
    expect(stateName('32')).toBe('Kerala')
    expect(stateName(null)).toBeNull()
  })
})

describe('the tax that turned on the missing state code', () => {
  it('treated every sale as local while the shop had no state', () => {
    // What the product did before this screen existed: `supplyTypeFor` answers
    // intra_state whenever either side is unknown, so a customer in another
    // state was charged CGST and SGST.
    expect(supplyTypeFor(null, '29')).toBe('intra_state')
  })

  it('charges IGST once the shop knows which state it is in', async () => {
    await saveShopProfile(fx.db, ctx(), { ...BLANK, stateCode: '33' })
    const shop = await getSetting(fx.db, 'shop_state_code')

    expect(supplyTypeFor(shop, '29')).toBe('inter_state')
    expect(supplyTypeFor(shop, '33')).toBe('intra_state')
  })
})

describe('the shop own mark', () => {
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('keeps the image itself, so a preview in a browser tab can print it too', async () => {
    const saved = await saveShopProfile(fx.db, ctx(), { ...BLANK, logo: PIXEL })
    expect(saved.ok).toBe(true)
    expect((await loadShopProfile(fx.db)).logo).toBe(PIXEL)
  })

  it('refuses a file that is not an image it can put in a page', async () => {
    const saved = await saveShopProfile(fx.db, ctx(), { ...BLANK, logo: 'data:text/html;base64,PHNjcmlwdD4=' })
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe('BAD_LOGO')
  })

  it('refuses one too big to ride on every bill', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(400 * 1024)}`
    const saved = await saveShopProfile(fx.db, ctx(), { ...BLANK, logo: huge })
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.code).toBe('LOGO_TOO_BIG')
  })

  it('records that the mark changed without writing the mark into the history', async () => {
    await saveShopProfile(fx.db, ctx(), { ...BLANK, logo: PIXEL })
    const row = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity_id = 'shop_profile' ORDER BY at DESC LIMIT 1`,
    )
    expect(row?.diff).toContain('an image')
    expect(row?.diff).not.toContain('iVBOR')
  })
})
