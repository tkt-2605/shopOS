import { describe, it, expect, afterEach } from 'vitest'
import { handTheMainTo, listens, makeThisTheMain, tillRole } from '../src/services/sync/layout.js'
import { setDeviceId } from '../src/device.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * A main that hands its place on, in a shop paired before there was a main
 * (077). Every till there holds every other's address, so the old main, now a
 * till, had no till dialling it without one and stopped answering at once --
 * while the new main, which learns it is the main only by dialling the old
 * one, went on dialling a till that no longer answered. Both waited for ever.
 */

const ME = 'aaaa1111-1111-4111-8111-111111111111'
const OTHER = 'bbbb2222-2222-4222-8222-222222222222'
let fx: Fixture

afterEach(async () => { setDeviceId(null); await fx.db.close() })

async function pairedEqually() {
  fx = await freshDb()
  setDeviceId(ME)
  await fx.db.execute(
    `INSERT INTO sync_peers (device_id, secret, address, created_at) VALUES (?, 's', 'http://192.168.31.237:7801', ?)`,
    [OTHER, new Date().toISOString()],
  )
  expect(await tillRole(fx.db)).toBe('equals')
  await makeThisTheMain(fx.db, fx.adminId)
}

const agreedWithOther = (at: string) =>
  fx.db.execute(`UPDATE sync_peers SET last_agreed_at = ? WHERE device_id = ?`, [at, OTHER])

describe('handing the main on in a shop paired before there was a main', () => {
  it('goes on answering until the new main has caught up with it, then stops', async () => {
    await pairedEqually()
    await agreedWithOther(new Date(Date.now() - 60_000).toISOString())
    await handTheMainTo(fx.db, OTHER, fx.adminId)
    expect(await tillRole(fx.db)).toBe('till')
    expect(await listens(fx.db), 'still answering, so the new main can hear it is the main').toBe(true)

    await agreedWithOther(new Date(Date.now() + 1000).toISOString())
    expect(await listens(fx.db), 'the new main has caught up: a till that is dialled by nobody stops').toBe(false)
  })

  it('answers when the new main has never caught up with it at all', async () => {
    await pairedEqually()
    await handTheMainTo(fx.db, OTHER, fx.adminId)
    expect(await listens(fx.db)).toBe(true)
  })

  it('is no reason to answer on a till that never handed over', async () => {
    fx = await freshDb()
    setDeviceId(ME)
    await fx.db.execute(
      `INSERT INTO sync_peers (device_id, secret, address, created_at) VALUES (?, 's', 'http://192.168.31.237:7801', ?)`,
      [OTHER, new Date().toISOString()],
    )
    // This till follows another main it was told of, and dials it.
    await fx.db.execute(`UPDATE sync_state SET main_device = ?, main_epoch = 1 WHERE id = 1`, [OTHER])
    expect(await tillRole(fx.db)).toBe('till')
    expect(await listens(fx.db)).toBe(false)
  })
})
