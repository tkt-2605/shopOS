import { describe, it, expect, afterEach } from 'vitest'
import { handleSyncRequest } from '../src/services/syncServer.js'
import { collectChanges } from '../src/services/sync.js'
import { sign, encodeAuth, forgetNonces } from '../src/services/syncAuth.js'
import { setDeviceId } from '../src/device.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { freshDb, emptyDb, makeProduct } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * The nonces a till has seen live in memory, so a restart forgets them and a
 * request captured just before it can be sent again. `syncAuth.ts` accepts
 * that because every endpoint is idempotent; this is what makes it true.
 */

const SHOP = '11111111-1111-4111-8111-111111111111'
const BACK = '22222222-2222-4222-8222-222222222222'
const SECRET = 'ab'.repeat(32)

afterEach(() => { setDeviceId(null); forgetNonces() })

async function signed(path: string, body: string) {
  return { path, body, auth: encodeAuth(await sign(SECRET, BACK, path, body)) }
}

async function offerOf(db: SqlDriver): Promise<string> {
  setDeviceId(BACK)
  const batch = await collectChanges(db, 0, 500, SHOP)
  return JSON.stringify({ ...batch, schemaVersion: EXPECTED_SCHEMA_VERSION })
}

describe('a request replayed after a restart', () => {
  it('changes nothing: an older offer loses to what is here, and no cursor moves back', async () => {
    const shop = (await freshDb()).db
    const back = await emptyDb()
    await shop.execute(
      `INSERT INTO sync_peers (device_id, secret, created_at) VALUES (?, ?, ?)`,
      [BACK, SECRET, new Date().toISOString()],
    )
    const id = await makeProduct(back, { name: 'Rice' })

    const first = await signed('/offer', await offerOf(back))
    setDeviceId(SHOP)
    expect((await handleSyncRequest(shop, first)).status).toBe(200)

    await back.execute(`UPDATE products SET name = 'Ponni rice' WHERE id = ?`, [id])
    const second = await signed('/offer', await offerOf(back))
    setDeviceId(SHOP)
    expect((await handleSyncRequest(shop, second)).status).toBe(200)
    const cursor = await shop.get<{ c: number }>(`SELECT their_cursor AS c FROM sync_peers WHERE device_id = ?`, [BACK])

    forgetNonces() // the restart
    setDeviceId(SHOP)
    expect((await handleSyncRequest(shop, first)).status, 'accepted again').toBe(200)

    expect((await shop.get<{ name: string }>(`SELECT name FROM products WHERE id = ?`, [id]))?.name).toBe('Ponni rice')
    expect(await shop.get(`SELECT their_cursor AS c FROM sync_peers WHERE device_id = ?`, [BACK])).toEqual(cursor)
    await shop.close()
    await back.close()
  })
})
