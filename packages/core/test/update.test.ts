import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  canInstall, dueForCheck, updateWords, CHECK_EVERY_MS,
  type UpdateStage, type AvailableUpdate,
} from '../src/services/update.js'
import { getOrOpenSession, closeSession } from '../src/services/cash.js'
import { rupees } from '../src/money.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * An update must never be the reason a shop's day went wrong.
 *
 * Two rules, and both of them are about restraint rather than capability:
 * an install waits for the drawer, and a failure to reach the update server
 * is not an error anybody is shown.
 */

const UPDATE: AvailableUpdate = { version: '0.2.0', notes: 'Faster', publishedAt: null }

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('installing', () => {
  it('waits while a drawer is open, and names the counter', async () => {
    const ready: UpdateStage = { stage: 'ready', update: UPDATE }
    expect(await canInstall(fx.db, ready)).toEqual({ ok: true })

    await getOrOpenSession(fx.db, {
      registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000),
    })

    const refused = await canInstall(fx.db, ready)
    expect(refused).toMatchObject({ ok: false, code: 'SESSION_OPEN' })
    if (refused.ok || refused.code !== 'SESSION_OPEN') return
    expect(refused.registerName).not.toBeNull()

    /* The sentence a person can act on. "A session is open" is not one;
       "close the drawer at Counter 1 first" is. */
    expect(updateWords(ready, refused)).toContain(refused.registerName!)
  })

  it('goes ahead once the drawer is closed', async () => {
    const opened = await getOrOpenSession(fx.db, {
      registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000),
    })
    await closeSession(fx.db, {
      sessionId: opened.sessionId, userId: fx.adminId, actualCash: rupees(1000),
    })

    expect(await canInstall(fx.db, { stage: 'ready', update: UPDATE })).toEqual({ ok: true })
  })

  it('refuses anything that is not downloaded and verified', async () => {
    for (const stage of [
      { stage: 'idle', checkedAt: null },
      { stage: 'checking' },
      { stage: 'available', update: UPDATE },
      { stage: 'downloading', update: UPDATE, percent: 50 },
    ] satisfies UpdateStage[]) {
      expect(await canInstall(fx.db, stage)).toMatchObject({ ok: false, code: 'NOT_READY' })
    }
  })
})

describe('when to ask', () => {
  it('asks at start, then once a day', () => {
    const start = 1_800_000_000_000
    expect(dueForCheck({ stage: 'idle', checkedAt: null }, start)).toBe(true)
    expect(dueForCheck({ stage: 'idle', checkedAt: start }, start + 1000)).toBe(false)
    expect(dueForCheck({ stage: 'idle', checkedAt: start }, start + CHECK_EVERY_MS)).toBe(true)
  })

  it('does not ask again once it knows about one', () => {
    const now = Date.now()
    expect(dueForCheck({ stage: 'available', update: UPDATE }, now)).toBe(false)
    expect(dueForCheck({ stage: 'ready', update: UPDATE }, now)).toBe(false)
  })

  it('does not ask while it is busy', () => {
    const now = Date.now()
    expect(dueForCheck({ stage: 'checking' }, now)).toBe(false)
    expect(dueForCheck({ stage: 'downloading', update: UPDATE, percent: 1 }, now)).toBe(false)
    expect(dueForCheck({ stage: 'installing', update: UPDATE }, now)).toBe(false)
  })

  it('retries a failure tomorrow, not in a loop', () => {
    const at = Date.now()
    const failed: UpdateStage = { stage: 'failed', why: 'ENOTFOUND', checkedAt: at }
    expect(dueForCheck(failed, at + 60_000)).toBe(false)
    expect(dueForCheck(failed, at + CHECK_EVERY_MS)).toBe(true)
  })
})

describe('what the shop is told', () => {
  it('says nothing at all while nothing is happening', () => {
    expect(updateWords({ stage: 'idle', checkedAt: null })).toBe('')
    expect(updateWords({ stage: 'checking' })).toBe('')
  })

  it('says nothing when the update server could not be reached', () => {
    /* A till on a dead line is a working till. A red banner here would be a
       banner people learn to ignore, and the next one might matter. */
    expect(updateWords({ stage: 'failed', why: 'ENOTFOUND', checkedAt: Date.now() })).toBe('')
  })

  it('names the version at every stage a person sees', () => {
    expect(updateWords({ stage: 'available', update: UPDATE })).toContain('0.2.0')
    expect(updateWords({ stage: 'downloading', update: UPDATE, percent: 42 })).toContain('42%')
    expect(updateWords({ stage: 'ready', update: UPDATE })).toContain('0.2.0')
    expect(updateWords({ stage: 'installing', update: UPDATE })).toContain('restart')
  })
})
