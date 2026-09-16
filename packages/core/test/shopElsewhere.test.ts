import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { setSetting } from '../src/services/bootstrap.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * A shop that is not in Tamil Nadu.
 *
 * Every test that bills runs against a fixture in state `33`, and until
 * recently so did every row in the only database anybody had. That is a trap
 * rather than a coincidence: `customers.ts` used to write the literal `'33'`
 * into its INSERT, and because the shop was *also* in `33` the fabrication and
 * the truth coincided. Every bill came out intra-state and every bill was right
 * by accident. The customer half of that is now proved wrong by a `27` customer
 * getting IGST (`returnsInGst.test.ts`); the shop half was not proved by
 * anything, because nothing had ever billed from anywhere but `33`.
 *
 * So the shop moves to Maharashtra. If the supply type were reading a constant
 * instead of the setting, every assertion below would come out backwards: the
 * local sale would be taxed as inter-state and the Tamil Nadu one as local.
 *
 * This was on the plan as a check to be staged by hand on a copy of the owner's
 * database, because that database could not reach the inter-state path on its
 * own. It never needed to be — the case is two settings and a customer, and a
 * test runs it on every push where a staged copy runs once and is forgotten.
 */

let fx: Fixture

const MUMBAI = '27'
const CHENNAI = '33'

beforeEach(async () => {
  fx = await freshDb()
  // Registered in Maharashtra, which is what `freshDb` is not.
  await setSetting(fx.db, 'shop_state_code', MUMBAI)
  await setSetting(fx.db, 'shop_gstin', '27AABCR5678G1Z2')
})
afterEach(async () => { await fx.db.close() })

/** What the bill actually stored, which is what the return is filed on. */
async function taxOn(db: SqlDriver, billId: string) {
  return db.get<{ cgst: number; sgst: number; igst: number; taxable: number }>(
    `SELECT COALESCE(SUM(cgst_amount), 0) AS cgst,
            COALESCE(SUM(sgst_amount), 0) AS sgst,
            COALESCE(SUM(igst_amount), 0) AS igst,
            COALESCE(SUM(taxable_value), 0) AS taxable
       FROM bill_items WHERE bill_id = ?`,
    [billId],
  )
}

async function sellTo(customerId: string | null): Promise<string> {
  const productId = await makeProduct(fx.db, { baseRate: rupees(590), taxRateBp: 1800 })
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(customerId ? { customerId } : {}),
    lines: [{ productId, qty: fromUnits(2) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft refused')
  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(`submit refused: ${done.code}`)
  return draft.billId
}

async function customerIn(state: string, name: string): Promise<string> {
  const id = await makeCustomer(fx.db, name)
  await fx.db.execute(`UPDATE customers SET state_code = ? WHERE id = ?`, [state, id])
  return id
}

describe('a shop in Maharashtra', () => {
  it('charges CGST and SGST to a customer in Maharashtra', async () => {
    const billId = await sellTo(await customerIn(MUMBAI, 'Deshmukh Stores'))
    const tax = await taxOn(fx.db, billId)

    expect(tax!.igst).toBe(0)
    expect(tax!.cgst).toBeGreaterThan(0)
    expect(tax!.cgst).toBe(tax!.sgst)
    // 18% of ₹1,180 inclusive: ₹1,000 taxable, ₹90 each side.
    expect(tax!.taxable).toBe(rupees(1000))
    expect(tax!.cgst).toBe(rupees(90))
  })

  it('charges IGST to a customer in Tamil Nadu', async () => {
    /* The half that would read backwards if anything were assuming `33`: this
       is the *same* state code that is intra-state in every other test in the
       suite, and here it has to be inter-state. */
    const billId = await sellTo(await customerIn(CHENNAI, 'Shanmugam & Sons'))
    const tax = await taxOn(fx.db, billId)

    expect(tax!.cgst).toBe(0)
    expect(tax!.sgst).toBe(0)
    expect(tax!.igst).toBe(rupees(180))
    expect(tax!.taxable).toBe(rupees(1000))
  })

  it('treats a walk-in as local, because a customer who said nothing is standing here', async () => {
    const billId = await sellTo(null)
    const tax = await taxOn(fx.db, billId)

    expect(tax!.igst).toBe(0)
    expect(tax!.cgst).toBe(tax!.sgst)
    expect(tax!.cgst).toBeGreaterThan(0)
  })

  it('writes the place of supply as the customer_s state and not its own', async () => {
    /* Rule 46(n). The renderer was never wrong about this; what filled it in
       was, on every invoice the till had printed — including the ones billed to
       another state and charged IGST. */
    const local = await sellTo(await customerIn(MUMBAI, 'Deshmukh Stores'))
    const away = await sellTo(await customerIn(CHENNAI, 'Shanmugam & Sons'))

    const rows = await fx.db.query<{ id: string; place_of_supply: string | null; supply_type: string | null }>(
      `SELECT id, place_of_supply, supply_type FROM bills WHERE id IN (?, ?)`,
      [local, away],
    )
    const by = new Map(rows.map((r) => [r.id, r]))
    expect(by.get(local)).toMatchObject({ place_of_supply: MUMBAI, supply_type: 'intra_state' })
    expect(by.get(away)).toMatchObject({ place_of_supply: CHENNAI, supply_type: 'inter_state' })
  })

  it('adds up to the same money either way, because the split is not a surcharge', async () => {
    /* Eighteen per cent is eighteen per cent. A shop that charged a customer in
       another state more would be a shop with a bug, and the two halves above
       assert different columns — this is what says they are two presentations
       of one number. */
    const local = await sellTo(await customerIn(MUMBAI, 'Deshmukh Stores'))
    const away = await sellTo(await customerIn(CHENNAI, 'Shanmugam & Sons'))

    const totals = await fx.db.query<{ id: string; grand_total: number; tax_total: number }>(
      `SELECT id, grand_total, tax_total FROM bills WHERE id IN (?, ?)`, [local, away],
    )
    const [a, b] = totals
    expect(a!.grand_total).toBe(b!.grand_total)
    expect(a!.tax_total).toBe(b!.tax_total)
  })
})
