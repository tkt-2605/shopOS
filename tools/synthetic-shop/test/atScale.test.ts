import { describe, it, expect, beforeAll } from 'vitest'
import { openMemoryDatabase } from '@shopos/core/node'
import {
  migrate, searchCustomers, countCustomers, totalOutstandingAll, type SqlDriver,
} from '@shopos/core'
import { MIGRATIONS } from '@shopos/core/migrations'
import { buildSyntheticShop, type SyntheticShop } from '../src/build.js'

/**
 * The Phase 3 checks that only exist at size.
 *
 * Each of these is a line on the phase's verification list that reads "on the
 * synthetic 20,000-bill shop" or "on a shop with 600 customers". They are here
 * rather than in `packages/core/test` because building the shop takes a couple
 * of seconds and the core suite should stay instant; the *meanings* are tested
 * there, on nine rows, where a failure says which rule broke.
 */

let db: SqlDriver
let shop: SyntheticShop

beforeAll(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  shop = await buildSyntheticShop(db)
}, 120_000)

describe('what the shop is owed, on a shop with six hundred customers', () => {
  it('is the whole book and not the page of it the screen holds', async () => {
    const book = await totalOutstandingAll(db)
    expect(book.total).toBe(shop.outstanding)
    expect(await countCustomers(db)).toBe(600)
  })

  it('is more than the old arithmetic could see', async () => {
    /* What the Credit page did until now: load five hundred customers ordered
       by name, keep the ones who owe, add those up. On six hundred customers
       the hundred at the back of the alphabet are not loaded at all, so their
       debt is not in the figure and nothing on the screen says a hundred
       customers were left out.

       This is the bug, reproduced, so the fix has something to be a fix of. */
    const loaded = await searchCustomers(db, '', 500)
    const asShown = loaded.reduce((sum, c) => (c.outstanding > 0 ? sum + c.outstanding : sum), 0)

    const book = await totalOutstandingAll(db)
    expect(asShown).toBeLessThan(book.total)
    expect(book.total - asShown).toBeGreaterThan(0)

    // And it was short by real money, not by a rounding difference.
    expect(book.total - asShown).toBeGreaterThan(100_00)
  })

  it('counts the customers who owe, not the rows that fitted', async () => {
    const book = await totalOutstandingAll(db)
    const loadedAndOwing = (await searchCustomers(db, '', 500)).filter((c) => c.outstanding > 0).length
    expect(book.customers).toBeGreaterThan(loadedAndOwing)
  })

  it('names the same worst customer the whole book would', async () => {
    const book = await totalOutstandingAll(db)
    const everyone = await searchCustomers(db, '', 10_000)
    const worst = everyone.reduce((w, c) => (c.outstanding > w.outstanding ? c : w), everyone[0]!)

    expect(book.worst).not.toBeNull()
    expect(book.worst!.id).toBe(worst.id)
    expect(book.worst!.outstanding).toBe(worst.outstanding)
  })

  it('answers in two passes rather than six hundred', async () => {
    /* A budget, not a benchmark. The point is the shape of the query, and the
       shape that would fail this is the obvious one: a correlated subquery per
       customer, re-reading twenty thousand bills for every name on the list.
       Generous enough not to go red on a loaded CI box. */
    const started = Date.now()
    await totalOutstandingAll(db)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
