import { describe, it, expect } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { resolvePrice, type PriceCandidates } from '../src/domain/pricing.js'

const base: PriceCandidates = {
  baseRate: rupees(100),
  defaultListTiers: [
    { id: 'd0', minQty: fromUnits(0), rate: rupees(95) },
    { id: 'd10', minQty: fromUnits(10), rate: rupees(90) },
    { id: 'd50', minQty: fromUnits(50), rate: rupees(85) },
  ],
  customerListTiers: [
    { id: 'w0', minQty: fromUnits(0), rate: rupees(88) },
    { id: 'w20', minQty: fromUnits(20), rate: rupees(80) },
  ],
  customerOverride: { id: 'o1', rate: rupees(70) },
}

describe('price resolution order', () => {
  it('prefers a customer-specific rate above everything', () => {
    const r = resolvePrice(base, fromUnits(100))
    expect(r.rate).toBe(rupees(70))
    expect(r.source).toBe('customer_override')
    expect(r.sourceId).toBe('o1')
  })

  it("falls to the customer's price list when there is no override", () => {
    const r = resolvePrice({ ...base, customerOverride: null }, fromUnits(25))
    expect(r.rate).toBe(rupees(80))
    expect(r.source).toBe('customer_list')
    expect(r.sourceId).toBe('w20')
  })

  it('falls to the default list when the customer has no list', () => {
    const r = resolvePrice({ ...base, customerOverride: null, customerListTiers: [] }, fromUnits(10))
    expect(r.rate).toBe(rupees(90))
    expect(r.source).toBe('default_list')
    expect(r.sourceId).toBe('d10')
  })

  it('falls to the product base rate when no list matches', () => {
    const r = resolvePrice({ baseRate: rupees(100) }, fromUnits(1))
    expect(r.rate).toBe(rupees(100))
    expect(r.source).toBe('base_rate')
    expect(r.sourceId).toBeNull()
  })

  it('always reports a source', () => {
    for (const qty of [0, 1, 9.9999, 10, 19, 20, 49, 50, 1000]) {
      const r = resolvePrice(base, fromUnits(qty))
      expect(r.source).toBeTruthy()
    }
  })
})

describe('tier boundaries', () => {
  const tiers = { baseRate: rupees(100), defaultListTiers: base.defaultListTiers }

  it('is inclusive at the break point', () => {
    expect(resolvePrice(tiers, fromUnits(10)).sourceId).toBe('d10')
  })

  it('does not apply a tier below its break point', () => {
    expect(resolvePrice(tiers, fromUnits(9.9999)).sourceId).toBe('d0')
  })

  it('picks the highest tier the quantity reaches', () => {
    expect(resolvePrice(tiers, fromUnits(999)).sourceId).toBe('d50')
  })

  it('handles unordered tier rows', () => {
    const shuffled = {
      baseRate: rupees(100),
      defaultListTiers: [
        { id: 'd50', minQty: fromUnits(50), rate: rupees(85) },
        { id: 'd0', minQty: fromUnits(0), rate: rupees(95) },
        { id: 'd10', minQty: fromUnits(10), rate: rupees(90) },
      ],
    }
    expect(resolvePrice(shuffled, fromUnits(20)).sourceId).toBe('d10')
  })
})

describe('validity windows', () => {
  const on = new Date('2026-06-15T00:00:00Z')

  it('skips an expired override and uses the list instead', () => {
    const r = resolvePrice(
      { ...base, customerOverride: { id: 'o1', rate: rupees(70), validTo: '2026-01-01T00:00:00Z' } },
      fromUnits(25),
      on,
    )
    expect(r.source).toBe('customer_list')
  })

  it('skips a tier that has not started', () => {
    const r = resolvePrice(
      {
        baseRate: rupees(100),
        defaultListTiers: [{ id: 'future', minQty: fromUnits(0), rate: rupees(50), validFrom: '2027-01-01T00:00:00Z' }],
      },
      fromUnits(1),
      on,
    )
    expect(r.source).toBe('base_rate')
  })

  it('honours a window that is currently open', () => {
    const r = resolvePrice(
      {
        baseRate: rupees(100),
        defaultListTiers: [
          { id: 'sale', minQty: fromUnits(0), rate: rupees(50), validFrom: '2026-01-01T00:00:00Z', validTo: '2026-12-31T00:00:00Z' },
        ],
      },
      fromUnits(1),
      on,
    )
    expect(r.rate).toBe(rupees(50))
  })
})
