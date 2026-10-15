import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { open, seal, makeVendorKey, publicOf, type Manifest, type VendorKey } from '../src/sod.js'

/**
 * The file a till seals its shop's data into, opened on the vendor's side.
 *
 * `fixture.sod` was sealed in Rust by `support_data.rs` (its ignored test
 * `make_the_fixture`) to the test-only key beside it, so this is the till's
 * code and the vendor's tool agreeing on one file -- not one side agreeing
 * with itself.
 */

const fixtureKey = JSON.parse(readFileSync(new URL('./fixture-key.json', import.meta.url), 'utf8')) as VendorKey
const fixture = readFileSync(new URL('./fixture.sod', import.meta.url))

const manifest: Manifest = {
  format: 1, shopId: 'shop-1', deviceId: 'till-1', appVersion: '0.3.0', madeAt: '2026-10-16T00:00:00Z',
  madeBy: 'admin', note: '', anonymised: false, customersHidden: 0,
}

describe('a file sealed by a till', () => {
  it('opens with the vendor key, manifest and database whole', () => {
    const opened = open(fixture, fixtureKey)
    expect(opened.manifest).toMatchObject({ shopId: 'fixture-shop', note: 'made by support_data.rs', anonymised: true })
    expect(opened.db.length).toBe(150_000)
    expect([...opened.db.subarray(0, 5)]).toEqual([0, 1, 2, 3, 4])
    expect(opened.db[149_999]).toBe(149_999 % 97)
  })

  it('does not open with any other key', () => {
    expect(() => open(fixture, makeVendorKey())).toThrow(/does not open with this key/)
  })

  it('does not open cut short, or with one byte changed', () => {
    expect(() => open(fixture.subarray(0, fixture.length - 20), fixtureKey)).toThrow()
    const changed = Buffer.from(fixture)
    changed[60] = changed[60]! ^ 1
    expect(() => open(changed, fixtureKey)).toThrow()
  })

  it('says plainly when a file is not one of these at all', () => {
    expect(() => open(Buffer.from('PK\u0003\u0004 a zip'), fixtureKey)).toThrow(/not a ShopOS data file/)
  })
})

describe('the vendor key', () => {
  it('round-trips a database larger than one chunk', () => {
    const key = makeVendorKey()
    const db = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 256))
    const opened = open(seal(manifest, db, publicOf(key)), key)
    expect(opened.db.equals(db)).toBe(true)
    expect(opened.manifest).toEqual(manifest)
  })

  it('publishes only the public half', () => {
    const key = makeVendorKey()
    expect(publicOf(key)).toBe(key.jwk.x)
    expect(publicOf(key)).not.toContain(key.jwk.d)
    expect(Buffer.from(publicOf(key), 'base64url')).toHaveLength(32)
  })
})
