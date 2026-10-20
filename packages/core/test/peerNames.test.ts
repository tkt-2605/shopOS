import { describe, it, expect, afterEach } from 'vitest'
import { listPeers } from '../src/services/sync/peers.js'
import { createRegister } from '../src/services/registers.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * What a till is called on the Other tills page: the counter it sits at. What
 * a till says of itself is the shop's name, the same on every till, so two
 * tills at one shop each listed the other as "TRT GENERAL STORE".
 */

const COUNTER1 = 'cccc3333-3333-4333-8333-333333333333'
const SPARE = 'dddd4444-4444-4444-8444-444444444444'
let fx: Fixture

afterEach(async () => { await fx.db.close() })

describe('the name a till goes by', () => {
  it('is the counter it sits at, over the shop name it says of itself', async () => {
    fx = await freshDb()
    const made = await createRegister(fx.db, { name: 'counter1', prefix: 'C1', actorId: fx.adminId })
    if (!made.ok) throw new Error(made.code)
    await fx.db.execute(`UPDATE registers SET claimed_by = ? WHERE id = ?`, [COUNTER1, made.registerId])
    const now = new Date().toISOString()
    for (const device of [COUNTER1, SPARE]) {
      await fx.db.execute(
        `INSERT INTO sync_peers (device_id, label, secret, created_at) VALUES (?, 'TRT GENERAL STORE', 's', ?)`, [device, now])
    }
    const names = new Map((await listPeers(fx.db)).map((p) => [p.deviceId, p.label]))
    expect(names.get(COUNTER1)).toBe('counter1')
    // A till at no counter has only what it said.
    expect(names.get(SPARE)).toBe('TRT GENERAL STORE')
  })
})
