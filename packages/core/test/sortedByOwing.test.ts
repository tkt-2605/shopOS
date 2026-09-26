import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { searchCustomers } from '../src/repos/catalog.js'
import { recordOpeningBalance } from '../src/services/payments.js'
import { freshDb, makeCustomer, type Fixture } from './helpers.js'

/**
 * Who to chase first, decided by the database.
 *
 * The collection list stops at five hundred names. Sorting the rows after
 * they arrive sorts an arbitrary five hundred of six hundred — so the
 * customer who owes the most may not be in the page that got sorted, and the
 * screen would look completely correct while naming the wrong person. That is
 * why `order` is an argument to the query and not a `.sort()` on the result.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function owes(name: string, amount: Money) {
  const id = await makeCustomer(fx.db, name)
  await recordOpeningBalance(fx.db, {
    customerId: id, amount, registerId: fx.seed.registerId, actorId: fx.adminId,
  })
  return id
}

describe('ordering the collection list', () => {
  it('puts the biggest debt first', async () => {
    await owes('Anand', rupees(100))
    await owes('Bala', rupees(9000))
    await owes('Chandra', rupees(2500))

    const list = await searchCustomers(fx.db, '', 50, { order: 'owing' })
    expect(list.map((c) => c.name)).toEqual(['Bala', 'Chandra', 'Anand'])
  })

  it('orders by name when asked, which is what a picker wants', async () => {
    await owes('Chandra', rupees(9000))
    await owes('Anand', rupees(100))

    const list = await searchCustomers(fx.db, '', 50, { order: 'name' })
    expect(list.map((c) => c.name)).toEqual(['Anand', 'Chandra'])
  })

  it('defaults to name, so a caller that says nothing gets something stable', async () => {
    await owes('Chandra', rupees(9000))
    await owes('Anand', rupees(100))

    expect((await searchCustomers(fx.db, '', 50)).map((c) => c.name))
      .toEqual(['Anand', 'Chandra'])
  })

  it('breaks a tie by name rather than leaving it to the planner', async () => {
    /* Two customers owing the same amount must not swap places between one
       load and the next. A list that reorders itself under somebody's finger
       is how the wrong row gets tapped. */
    await owes('Zubair', rupees(500))
    await owes('Anand', rupees(500))

    const once = await searchCustomers(fx.db, '', 50, { order: 'owing' })
    const again = await searchCustomers(fx.db, '', 50, { order: 'owing' })
    expect(once.map((c) => c.name)).toEqual(['Anand', 'Zubair'])
    expect(again.map((c) => c.name)).toEqual(once.map((c) => c.name))
  })

  it('sorts across the whole shop, not the page it would have returned', async () => {
    /* The point of the whole exercise. The big debt is on a customer whose
       name puts them last alphabetically, and the limit is smaller than the
       shop: if the ordering happened after the limit, this would miss them. */
    for (const name of ['Anand', 'Bala', 'Chandra', 'Deepa']) await owes(name, rupees(100))
    await owes('Zubair', rupees(50_000))

    const top = await searchCustomers(fx.db, '', 2, { order: 'owing' })
    expect(top[0]?.name).toBe('Zubair')
    expect(top).toHaveLength(2)
  })

  it('puts somebody the shop is holding money for near the top too', async () => {
    /* A customer 500 in credit is as much of a loose end as one owing 500 —
       the shop has to either knock it off a bill or hand it back. */
    await owes('Anand', rupees(100))
    const held = await makeCustomer(fx.db, 'Zubair')
    await recordOpeningBalance(fx.db, {
      customerId: held, amount: -rupees(5000) as Money,
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })

    const list = await searchCustomers(fx.db, '', 50, { order: 'owing' })
    // Anand owes, so leads; Zubair is held rather than owed, and comes next.
    expect(list.map((c) => c.name)).toEqual(['Anand', 'Zubair'])
    expect(list[1]?.advance).toBe(rupees(5000))
  })
})
