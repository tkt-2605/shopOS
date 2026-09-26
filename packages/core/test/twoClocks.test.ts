import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  entitlement, entitled, installToken, removeToken, storedCodes, storedToken,
} from '../src/services/licence.js'
import { setSetting } from '../src/services/bootstrap.js'
import { freshDb, type Fixture } from './helpers.js'
import { TEST_KEYS, signLicence } from './licenceHelper.js'

/**
 * A shop holding two licences with two different clocks.
 *
 * A second counter costs the vendor nothing to keep running, so it is sold
 * once and never expires. The cloud costs money every month, so it recurs.
 * One token cannot say both — it carries one `tier` and one `paidThrough` —
 * and the consequence of trying was the reason this file exists:
 *
 *   **a shop that bought the counter outright and later let its cloud
 *   subscription lapse lost the counter it had paid for.**
 *
 * `keeps what was bought outright when the subscription lapses` is the test
 * that says it must not. Everything else here is scaffolding around it.
 */

const ctx = { actorId: 'owner' }
const opts = { keys: TEST_KEYS }

let fx: Fixture
let shopId: string

beforeEach(async () => {
  fx = await freshDb()
  const id = await fx.db.get<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?', ['shop_id'],
  )
  shopId = id!.value
})
afterEach(async () => { await fx.db.close() })

/** A perpetual licence: bought once, never expires. */
const forever = (tier: 'single' | 'multi' | 'cloud' | 'branches') =>
  signLicence(shopId, tier, null)

/** A subscription, with a date on it. */
const until = (tier: 'cloud' | 'branches', date: string) => signLicence(shopId, tier, date)

async function install(code: string) {
  const result = await installToken(fx.db, ctx, code, opts)
  if (!result.ok) throw new Error(`install refused: ${result.code}`)
  return result
}

describe('holding two at once', () => {
  it('keeps both codes rather than replacing one with the other', async () => {
    await install(await forever('multi'))
    await install(await until('cloud', '2027-03-31'))

    expect(await storedCodes(fx.db)).toHaveLength(2)

    const state = await entitlement(fx.db, opts)
    expect(state.grants.map((g) => g.tier).sort()).toEqual(['cloud', 'multi'])
    expect(await entitled(fx.db, 'multiTill', opts)).toBe(true)
    expect(await entitled(fx.db, 'cloudPeer', opts)).toBe(true)
  })

  it('keeps what was bought outright when the subscription lapses', async () => {
    /* **The test this file exists for.**

       Two purchases, two clocks. The cloud one has run out; the counter was
       paid for once and is not on a clock at all. If this ever fails, a shop
       is being told that something it owns has expired — and it is being told
       that by the product it paid for, which is how a shopkeeper decides to
       tell other shopkeepers about you. */
    await install(await forever('multi'))
    await install(await until('cloud', '2020-01-01'))

    expect(await entitled(fx.db, 'multiTill', opts), 'bought outright, still owned').toBe(true)
    expect(await entitled(fx.db, 'cloudPeer', opts), 'subscription is over').toBe(false)
  })

  it('leads with what is in force, not with what ran out', async () => {
    /* A shop in exactly the state above opens Settings. The headline must not
       say "your licence ran out" when the thing it owns is working. */
    await install(await forever('multi'))
    await install(await until('cloud', '2020-01-01'))

    const state = await entitlement(fx.db, opts)
    expect(state.tier).toBe('multi')
    expect(state.state).toBe('active')
    expect(state.paidThrough, 'perpetual').toBeNull()
  })

  it('still says the highest thing in force when both are live', async () => {
    await install(await forever('multi'))
    await install(await until('cloud', '2027-03-31'))

    const state = await entitlement(fx.db, opts)
    expect(state.tier).toBe('cloud')
  })

  it('reads as lapsed only when nothing at all is in force', async () => {
    await install(await until('cloud', '2020-01-01'))
    const state = await entitlement(fx.db, opts)
    expect(state.state).toBe('lapsed')
  })
})

describe('renewing', () => {
  it('replaces the code for a tier rather than stacking two dates', async () => {
    /* Otherwise the card shows last year's date beside this year's with
       nothing to say which one is meant. */
    await install(await until('cloud', '2026-03-31'))
    await install(await until('cloud', '2027-03-31'))

    expect(await storedCodes(fx.db)).toHaveLength(1)
    const state = await entitlement(fx.db, opts)
    expect(state.paidThrough).toBe('2027-03-31')
  })

  it('does not touch a different tier while renewing one', async () => {
    await install(await forever('multi'))
    await install(await until('cloud', '2026-03-31'))
    await install(await until('cloud', '2027-03-31'))

    const tiers = (await entitlement(fx.db, opts)).grants.map((g) => g.tier).sort()
    expect(tiers).toEqual(['cloud', 'multi'])
  })

  it('does not store the same code twice', async () => {
    const code = await forever('multi')
    await install(code)
    await install(code)
    expect(await storedCodes(fx.db)).toHaveLength(1)
  })
})

describe('removing one', () => {
  it('takes away only the code named', async () => {
    /* The cloud code goes; the perpetual one stays. Removing the *multi* code
       instead would prove nothing, because `cloud` outranks `multi` on the
       ladder and would go on allowing the counter by itself. */
    await install(await forever('multi'))
    const cloud = await until('cloud', '2027-03-31')
    await install(cloud)

    await removeToken(fx.db, ctx, cloud)

    expect(await storedCodes(fx.db)).toHaveLength(1)
    expect(await entitled(fx.db, 'cloudPeer', opts), 'the cloud code is gone').toBe(false)
    expect(await entitled(fx.db, 'multiTill', opts), 'the bought one is not').toBe(true)
  })

  it('takes away everything when no code is named', async () => {
    await install(await forever('multi'))
    await install(await until('cloud', '2027-03-31'))

    await removeToken(fx.db, ctx)

    expect(await storedCodes(fx.db)).toEqual([])
    expect((await entitlement(fx.db, opts)).state).toBe('none')
  })

  it('does nothing, and says nothing happened, for a code not held', async () => {
    await install(await forever('multi'))
    const before = await fx.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'licence' AND action = 'delete'`,
    )

    await removeToken(fx.db, ctx, await forever('cloud'))

    expect(await storedCodes(fx.db)).toHaveLength(1)
    const after = await fx.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'licence' AND action = 'delete'`,
    )
    expect(after?.n, 'no audit row for a removal that did not happen').toBe(before?.n)
  })
})

describe('a bad code among good ones', () => {
  it('does not hide a licence that is fine', async () => {
    /* Somebody pastes the updater key, or a code for another shop, on top of
       a working licence. The working one must go on working. */
    await install(await forever('multi'))
    await setSetting(
      fx.db, 'licence_token',
      `${(await storedCodes(fx.db))[0]}\nnot-a-licence-at-all`,
      new Date().toISOString(),
    )

    const state = await entitlement(fx.db, opts)
    expect(state.grants).toHaveLength(1)
    expect(state.problem, 'and the bad one is still reported').toBe('MALFORMED')
    expect(await entitled(fx.db, 'multiTill', opts)).toBe(true)
  })

  it('reports a code for another shop without losing this shop’s', async () => {
    await install(await forever('multi'))
    const theirs = await signLicence('somebody-elses-shop', 'branches', null)
    await setSetting(
      fx.db, 'licence_token',
      `${(await storedCodes(fx.db))[0]}\n${theirs}`,
      new Date().toISOString(),
    )

    const state = await entitlement(fx.db, opts)
    expect(state.problem).toBe('WRONG_SHOP')
    expect(await entitled(fx.db, 'multiTill', opts)).toBe(true)
    expect(await entitled(fx.db, 'branches', opts), 'theirs entitles us to nothing').toBe(false)
  })
})

describe('what a single code used to do, unchanged', () => {
  it('reads a till holding exactly one code, with no migration', async () => {
    /* A till that was holding one code before any of this existed has a
       setting with no newline in it. That is a list of one. */
    await setSetting(fx.db, 'licence_token', await until('cloud', '2027-03-31'), new Date().toISOString())

    const state = await entitlement(fx.db, opts)
    expect(state.tier).toBe('cloud')
    expect(state.paidThrough).toBe('2027-03-31')
    expect((await storedToken(fx.db))?.tier).toBe('cloud')
  })
})
