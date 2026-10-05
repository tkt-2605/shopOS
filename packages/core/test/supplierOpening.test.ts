import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { createSupplier, supplierSummaries, setSupplierOpening } from '../src/services/suppliers.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * What the shop already owed a supplier when the books moved.
 *
 * The customer side is a bill, because a bill is the only thing a payment can
 * be allocated against. The supplier side cannot be: there is no purchase
 * invoice to be the document, because purchases are Phase 5. So it is a
 * figure on the supplier — `050_what_the_shop_owed_before.sql` carries the
 * argument and the cost of that choice.
 */

/* The shop's own administrator, read when used: an actor is checked against
   the roles now, so a made-up name would be refused. */
const ctx = { get actorId(): string { return fx.adminId } }

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function supplier(name: string): Promise<string> {
  const made = await createSupplier(fx.db, { name, actorId: ctx.actorId })
  if (!made.ok) throw new Error(`could not create ${name}: ${made.code}`)
  return made.supplierId
}

async function summaryOf(id: string) {
  return (await supplierSummaries(fx.db)).find((s) => s.id === id)
}

describe('a supplier the shop owed', () => {
  it('carries the figure and the day the old book closed', async () => {
    const id = await supplier('Ramesh Traders')

    expect(await setSupplierOpening(fx.db, ctx, {
      supplierId: id, amount: rupees(12_000), asOf: '2026-03-31',
    })).toEqual({ ok: true, amount: rupees(12_000) })

    const row = await summaryOf(id)
    expect(row?.openingBalance).toBe(rupees(12_000))
    expect(row?.openingAsOf).toBe('2026-03-31')
  })

  it('takes a negative one, for an advance already paid', async () => {
    /* The shop paid ahead, or overpaid in the old book. Refusing this would
       mean recording an advance as a debt and paying it a second time. */
    const id = await supplier('Kumar Agencies')
    await setSupplierOpening(fx.db, ctx, { supplierId: id, amount: -rupees(3000) as Money })

    expect((await summaryOf(id))?.openingBalance).toBe(-rupees(3000))
  })

  it('tells "we owed nothing" apart from "nobody has said"', async () => {
    const asked = await supplier('Asked')
    const never = await supplier('Never asked')
    await setSupplierOpening(fx.db, ctx, { supplierId: asked, amount: rupees(0), asOf: '2026-03-31' })

    const answered = await summaryOf(asked)
    const silent = await summaryOf(never)

    // Both read zero. Only one of them has been answered.
    expect(answered?.openingBalance).toBe(0)
    expect(silent?.openingBalance).toBe(0)
    expect(answered?.openingAsOf).toBe('2026-03-31')
    expect(silent?.openingAsOf).toBeNull()
  })

  it('can be corrected, and the correction is audited', async () => {
    /* No ALREADY_SET, unlike the customer side: this is a field, and fixing a
       number somebody typed wrong is the ordinary case. The audit row is the
       whole trail until Phase 5 gives suppliers a ledger. */
    const id = await supplier('Ramesh Traders')
    await setSupplierOpening(fx.db, ctx, { supplierId: id, amount: rupees(12_000) })
    await setSupplierOpening(fx.db, ctx, { supplierId: id, amount: rupees(9000) })

    expect((await summaryOf(id))?.openingBalance).toBe(rupees(9000))

    const trail = await fx.db.query<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity = 'suppliers' AND entity_id = ? ORDER BY at`,
      [id],
    )
    expect(trail.length).toBeGreaterThanOrEqual(2)
    expect(trail.at(-1)?.diff).toContain('opening_balance')
  })

  it('defaults the date to today when none is given', async () => {
    const id = await supplier('Ramesh Traders')
    await setSupplierOpening(fx.db, ctx, { supplierId: id, amount: rupees(500) })
    expect((await summaryOf(id))?.openingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('refuses a supplier that does not exist rather than creating one', async () => {
    expect(await setSupplierOpening(fx.db, ctx, {
      supplierId: 'not-a-supplier', amount: rupees(500),
    })).toEqual({ ok: false, code: 'NO_SUPPLIER' })
  })

  it('is zero on every supplier that existed before the migration', async () => {
    // The column is NOT NULL DEFAULT 0, so an older row reads as answered-zero
    // for the amount and never-asked for the date. That is the right pair.
    const id = await supplier('Older than the column')
    const row = await summaryOf(id)
    expect(row?.openingBalance).toBe(0)
    expect(row?.openingAsOf).toBeNull()
  })
})
