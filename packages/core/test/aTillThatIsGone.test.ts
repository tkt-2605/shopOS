import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  claims, renewClaim, takeRegister, forgetPeer, ghostClaims, clearGhostClaims,
  claimIfUnclaimed, resolveDeviceRegister, CLAIM_GOES_STALE_MS,
} from '../src/services/registers.js'
import { pruneAcknowledged } from '../src/services/sync.js'
import { pendingCount, feedHead } from '../src/services/changefeed.js'
import { setDeviceId } from '../src/device.js'
import { makeProduct, freshDb, type Fixture } from './helpers.js'

/**
 * A machine that does not come back.
 *
 * `registers.claimed_by` was a lock with no expiry and no key, which is exactly
 * right while both tills are in the room and has no answer at all for the one
 * that is not. Two ways a shop gets there, and neither is unusual:
 *
 *   A restore. The backup carries the claim — it is a row — and `device.json`
 *   is deliberately not in the backup, because an identity a restore can
 *   duplicate is not an identity. So the machine comes up as a new till looking
 *   at a shop whose counters all belong to one that no longer exists. It cannot
 *   bill, and until 045 it could not take its own counter back either.
 *
 *   A till that is sold, stolen or dropped. Its peer row stays for ever, and
 *   `pruneAcknowledged` holds the change feed at the lowest cursor of every
 *   peer — so one machine nobody has seen since March pins the feed of every
 *   remaining till, which grows, is read further every round, and never says
 *   why.
 */

const THIS_TILL = '1111aaaa-1111-4111-8111-111111111111'
const THE_OTHER = '2222bbbb-2222-4222-8222-222222222222'
const A_GHOST = '3333cccc-3333-4333-8333-333333333333'

let fx: Fixture

beforeEach(async () => {
  fx = await freshDb()
  setDeviceId(THIS_TILL)
})
afterEach(async () => {
  setDeviceId(null)
  await fx.db.close()
})

const now = () => new Date().toISOString()

async function pairedWith(deviceId: string, label: string): Promise<void> {
  await fx.db.execute(
    `INSERT INTO sync_peers (device_id, label, secret, address, created_at)
     VALUES (?, ?, 'x', 'http://127.0.0.1:1', ?)`,
    [deviceId, label, now()],
  )
}

/** A second counter, claimed by somebody else at a given time. */
async function counterHeldBy(who: string, at: string | null): Promise<string> {
  const [row] = await fx.db.query<{ id: string }>(`SELECT id FROM registers LIMIT 1`)
  await fx.db.execute(
    `UPDATE registers SET claimed_by = ?, claimed_at = ? WHERE id = ?`,
    [who, at, row!.id],
  )
  return row!.id
}

describe('a counter somebody else is holding', () => {
  it('stays theirs while they are still starting up', async () => {
    await pairedWith(THE_OTHER, 'Back counter')
    const counter = await counterHeldBy(THE_OTHER, now())

    const claim = (await claims(fx.db)).get(counter)
    expect(claim?.label).toBe('Back counter')
    expect(claim?.stale, 'renewed today').toBe(false)
    expect(await takeRegister(fx.db, counter)).toMatchObject({ code: 'STILL_HELD' })
  })

  it('can be offered once nobody has renewed it for long enough', async () => {
    await pairedWith(THE_OTHER, 'Back counter')
    const longAgo = new Date(Date.now() - CLAIM_GOES_STALE_MS - 1000).toISOString()
    const counter = await counterHeldBy(THE_OTHER, longAgo)

    const claim = (await claims(fx.db)).get(counter)
    expect(claim?.stale).toBe(true)
    /* Named and dated, because "claimed" is not a question a shopkeeper can
       answer and "last used by Back counter on the 3rd" is. */
    expect(claim?.label).toBe('Back counter')
    expect(claim?.at).toBe(longAgo)

    expect(await takeRegister(fx.db, counter)).toEqual({ ok: true })
    expect((await claims(fx.db)).get(counter)?.mine).toBe(true)
  })

  it('survives a long weekend, which is the whole reason it is three days', async () => {
    await pairedWith(THE_OTHER, 'Back counter')
    const friday = new Date(Date.now() - 2.5 * 24 * 60 * 60 * 1000).toISOString()
    const counter = await counterHeldBy(THE_OTHER, friday)

    expect((await claims(fx.db)).get(counter)?.stale, 'still theirs on Monday').toBe(false)
  })

  it('is renewed by the till that holds it simply starting up', async () => {
    const counter = await counterHeldBy(THIS_TILL, null)
    await renewClaim(fx.db, counter)

    const claim = (await claims(fx.db)).get(counter)
    expect(claim?.mine).toBe(true)
    expect(claim?.at).not.toBeNull()
  })
})

describe('a claim that came in on a backup', () => {
  /* The holder is a device id this shop has never paired with and that is not
     this machine. No amount of waiting produces the till that made it. */
  it('is stale whatever its date says', async () => {
    const counter = await counterHeldBy(A_GHOST, now())

    expect((await claims(fx.db)).get(counter)?.stale, 'renewed a minute ago, and still a ghost')
      .toBe(true)
    expect(await ghostClaims(fx.db)).toHaveLength(1)
  })

  it('is cleared, so the restored machine can bill again', async () => {
    const counter = await counterHeldBy(A_GHOST, now())
    await pairedWith(THE_OTHER, 'Back counter')

    /* The state a restore leaves: any peer row at all, so the fallback to the
       first counter is off, and every counter held by a ghost. */
    expect(await resolveDeviceRegister(fx.db, counter), 'cannot bill').toBeNull()

    expect(await clearGhostClaims(fx.db)).toBe(1)
    await claimIfUnclaimed(fx.db, counter)

    expect(await resolveDeviceRegister(fx.db, counter)).toBe(counter)
  })

  it('leaves a counter held by a till this shop has actually met', async () => {
    await pairedWith(THE_OTHER, 'Back counter')
    await counterHeldBy(THE_OTHER, now())

    expect(await ghostClaims(fx.db)).toHaveLength(0)
    expect(await clearGhostClaims(fx.db)).toBe(0)
  })
})

describe('forgetting a till', () => {
  it('releases what it was holding', async () => {
    await pairedWith(THE_OTHER, 'Back counter')
    const counter = await counterHeldBy(THE_OTHER, now())

    await forgetPeer(fx.db, THE_OTHER)

    const claim = (await claims(fx.db)).get(counter)
    expect(claim?.deviceId, 'free, not stale — a person has said it is gone').toBeNull()
    await claimIfUnclaimed(fx.db, counter)
    expect((await claims(fx.db)).get(counter)?.mine).toBe(true)
  })

  it('lets the feed be pruned again', async () => {
    await pairedWith(THE_OTHER, 'Back counter')
    await pairedWith(A_GHOST, 'A till that was sold')
    await makeProduct(fx.db, { name: 'Notebook' })

    // The remaining till has read everything; the sold one never will.
    await fx.db.execute(
      `UPDATE sync_peers SET my_cursor = ? WHERE device_id = ?`,
      [await feedHead(fx.db), THE_OTHER],
    )

    expect(await pruneAcknowledged(fx.db), 'held at the sold till').toBe(0)
    expect(await pendingCount(fx.db, 0)).toBeGreaterThan(0)

    await forgetPeer(fx.db, A_GHOST)

    expect(await pruneAcknowledged(fx.db)).toBeGreaterThan(0)
    expect(await pendingCount(fx.db, 0)).toBe(0)
  })
})
