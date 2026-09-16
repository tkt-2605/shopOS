import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getOrOpenSession, closeSession, postCashMovement, listSessions,
} from '../src/services/cash.js'
import { rupees, type Money } from '../src/money.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * The drawer counts nobody could read back.
 *
 * `closeSession` has written `expected_cash`, `actual_cash` and `variance` on
 * every close since v1, and nothing in the product has ever selected them. A
 * shop counting its drawer every evening saw tonight's figure on the screen it
 * was counted on and never again — so the question a shopkeeper actually asks,
 * "is it short on the same person's shift every week", had no answer anywhere.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ALL = { from: '0000-01-01', to: '9999-12-31' }

/** Opens a drawer, puts money in it, and counts it. */
async function shift(input: {
  opening: number
  takings: number
  counted: number
  at: string
  notes?: string
}): Promise<string> {
  const { sessionId } = await getOrOpenSession(fx.db, {
    registerId: fx.seed.registerId,
    userId: fx.adminId,
    openingCash: rupees(input.opening) as Money,
    now: new Date(`${input.at}T09:00:00`),
  })

  if (input.takings > 0) {
    await fx.db.transaction(async (tx) => {
      await postCashMovement(tx, {
        sessionId,
        direction: 'in',
        amount: rupees(input.takings) as Money,
        method: 'cash',
        sourceType: 'bill',
        sourceId: 'x',
        userId: fx.adminId,
        now: new Date(`${input.at}T12:00:00`),
      })
    })
  }

  await closeSession(fx.db, {
    sessionId,
    actualCash: rupees(input.counted) as Money,
    userId: fx.adminId,
    ...(input.notes ? { notes: input.notes } : {}),
    now: new Date(`${input.at}T21:00:00`),
  })
  return sessionId
}

describe('the closes a shop can now look back at', () => {
  it('reports what was expected, what was counted and the difference', async () => {
    await shift({ opening: 1000, takings: 5000, counted: 5900, at: '2026-03-01', notes: 'One note short' })

    const rows = await listSessions(fx.db, ALL)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      openingCash: rupees(1000),
      expectedCash: rupees(6000),
      actualCash: rupees(5900),
      // Counted less expected: negative is money missing.
      variance: -rupees(100),
      notes: 'One note short',
      closedBy: 'admin',
    })
  })

  it('says which counter and which day, which is the whole question', async () => {
    await shift({ opening: 0, takings: 500, counted: 500, at: '2026-03-04' })

    const rows = await listSessions(fx.db, ALL)
    expect(rows[0]!.postingDate).toBe('2026-03-04')
    expect(rows[0]!.registerName).toBeTruthy()
  })

  it('leaves an open drawer out, having no variance to report', async () => {
    await getOrOpenSession(fx.db, {
      registerId: fx.seed.registerId,
      userId: fx.adminId,
      openingCash: rupees(1000) as Money,
    })

    /* A drawer that has not been counted has no variance, and a zero in that
       column would read as one that balanced. */
    expect(await listSessions(fx.db, ALL)).toEqual([])
  })

  it('filters on the day it was counted, not the day it was opened', async () => {
    await shift({ opening: 0, takings: 100, counted: 100, at: '2026-03-01' })
    await shift({ opening: 0, takings: 100, counted: 100, at: '2026-04-10' })

    /* A session opened at 9pm and closed after midnight belongs to the night it
       was counted, which is the evening somebody is asking about. */
    const march = await listSessions(fx.db, { from: '2026-03-01', to: '2026-03-31' })
    expect(march).toHaveLength(1)
    expect(march[0]!.postingDate).toBe('2026-03-01')
  })

  it('shows the most recently counted first, which is what gets looked at', async () => {
    await shift({ opening: 0, takings: 100, counted: 100, at: '2026-03-01' })
    await shift({ opening: 0, takings: 100, counted: 100, at: '2026-03-09' })
    await shift({ opening: 0, takings: 100, counted: 100, at: '2026-03-05' })

    expect((await listSessions(fx.db, ALL)).map((r) => r.postingDate))
      .toEqual(['2026-03-09', '2026-03-05', '2026-03-01'])
  })

  it('reports money over as plainly as money short', async () => {
    await shift({ opening: 0, takings: 1000, counted: 1050, at: '2026-03-01' })

    /* Over is not good news. It is the same evidence that something was rung up
       wrong, and a shop that only ever looks at the shortfalls finds half the
       mistakes. */
    expect((await listSessions(fx.db, ALL))[0]!.variance).toBe(rupees(50))
  })

  it('scopes to one counter when asked', async () => {
    await shift({ opening: 0, takings: 100, counted: 100, at: '2026-03-01' })

    const mine = await listSessions(fx.db, { ...ALL, registerId: fx.seed.registerId })
    expect(mine).toHaveLength(1)

    const other = await listSessions(fx.db, { ...ALL, registerId: 'some-other-counter' })
    expect(other).toEqual([])
  })
})
