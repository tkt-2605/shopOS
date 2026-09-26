import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncUntilDone, adoptRestoredIdentity } from '../src/services/sync.js'
import { handleSyncRequest, offerPairing, withdrawPairing } from '../src/services/syncServer.js'
import { httpTransport, pairWith, pairedPeers } from '../src/services/syncClient.js'
import { setDeviceId, deviceId, setReplacedDevice } from '../src/device.js'
import { forgetNonces } from '../src/services/syncAuth.js'
import { openDatabase } from '../src/db/node-driver.js'
import { freshDb, emptyDb, makeProduct } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * A till restored from its own backup, on the same machine.
 *
 * Before the restore took a new identity this lost data both ways, silently:
 * the shop's cursor on this till sat above the restored feed, so nothing
 * written after the restore was ever asked for, and the bills rung up here
 * between the backup and the restore were filed on the shop as having come
 * from this till, so they were never sent back. Both screens said the tills
 * agreed. Found in the pre-release review of 26 September.
 */

const SHOP = '11111111-1111-4111-8111-111111111111'
const BACK = '22222222-2222-4222-8222-222222222222'
const BACK_RESTORED = '33333333-3333-4333-8333-333333333333'

interface Till { id: string; db: SqlDriver }
let shop: Till & { server: Server; url: string }
let back: Till
let dir: string

async function as<T>(till: Till, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(till.id)
  try { return await fn() } finally { setDeviceId(before) }
}

beforeEach(async () => {
  forgetNonces()
  withdrawPairing()
  const fx = await freshDb()
  await licenseTill(fx.db)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const before = deviceId()
        setDeviceId(SHOP)
        try {
          const answer = await handleSyncRequest(fx.db, {
            path: req.url ?? '/', body,
            auth: (req.headers['x-shopos-auth'] as string | undefined) ?? null,
          }, undefined, { keys: TEST_KEYS })
          res.writeHead(answer.status, { 'content-type': 'application/json' })
          res.end(answer.body)
        } finally {
          setDeviceId(before)
        }
      })()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  shop = { id: SHOP, db: fx.db, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  back = { id: BACK, db: await emptyDb() }
  dir = mkdtempSync(join(tmpdir(), 'shopos-restore-'))
})

afterEach(async () => {
  setDeviceId(null)
  setReplacedDevice(null)
  withdrawPairing()
  await new Promise<void>((r) => shop.server.close(() => r()))
  await shop.db.close()
  await back.db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function pair(till: Till) {
  await as(till, () => pairWith(till.db, shop.url, offerPairing(), 'Back counter'))
}

async function catchUp(till: Till) {
  const [peer] = await pairedPeers(till.db)
  const result = await as(till, () => syncUntilDone(till.db, httpTransport(peer!, fetch)))
  expect(result.ok).toBe(true)
}

const has = async (till: Till, id: string) =>
  (await till.db.get(`SELECT id FROM products WHERE id = ?`, [id])) !== undefined

/** Pairs the back till, takes its backup, and writes one thing after it. */
async function aBackupAndADayAfter(): Promise<{ restored: Till; afterBackup: string }> {
  await pair(back)
  await catchUp(back)
  const file = join(dir, 'backup.db')
  await back.db.execute(`VACUUM INTO '${file}'`)

  const afterBackup = await makeProduct(back.db, { name: 'Rung up after the backup' })
  await catchUp(back)
  expect(await has(shop, afterBackup), 'the shop had it before the restore').toBe(true)

  return { restored: { id: BACK_RESTORED, db: openDatabase(file) }, afterBackup }
}

describe('a till restored from its own backup', () => {
  it('gets back what it wrote after the backup, and its new work reaches the shop', async () => {
    const { restored, afterBackup } = await aBackupAndADayAfter()
    try {
      const at = new Date().toISOString()
      const adopted = await as(restored, () => adoptRestoredIdentity(restored.db, { replaces: BACK, at }))
      expect(adopted.peersForgotten, 'the backup remembered the shop, secret stripped').toBe(1)

      setReplacedDevice(BACK)
      await pair(restored)
      const afterRestore = await makeProduct(restored.db, { name: 'Rung up after the restore' })
      await catchUp(restored)

      expect(await has(shop, afterRestore), 'new work leaves the restored till').toBe(true)
      expect(await has(restored, afterBackup), 'and what it had before comes back').toBe(true)
    } finally {
      await restored.db.close()
    }
  })

  it('takes the old till\'s place on the shop rather than being a second one', async () => {
    const { restored } = await aBackupAndADayAfter()
    try {
      // A lapsed plan does not stop a counter the shop already has getting back in.
      await licenseTill(shop.db, 'multi', '2020-01-01')
      setReplacedDevice(BACK)
      await pair(restored)

      const peers = await shop.db.query<{ device_id: string }>(`SELECT device_id FROM sync_peers`)
      expect(peers.map((p) => p.device_id)).toEqual([BACK_RESTORED])
    } finally {
      await restored.db.close()
    }
  })
})

describe('adopting a restored identity', () => {
  it('moves the counter to the new identity and forgets only the peers from before', async () => {
    const fx = await freshDb()
    const db = fx.db
    const register = fx.seed.registerId
    const before = '2026-09-01T00:00:00.000Z'
    await db.execute(`UPDATE registers SET claimed_by = ? WHERE id = ?`, [BACK, register])
    await db.execute(`INSERT INTO sync_peers (device_id, created_at) VALUES (?, ?)`, [SHOP, before])

    const at = '2026-09-26T10:00:00.000Z'
    const first = await as({ id: BACK_RESTORED, db }, () => adoptRestoredIdentity(db, { replaces: BACK, at }))
    expect(first).toEqual({ counters: 1, peersForgotten: 1 })
    const held = await db.get<{ claimed_by: string }>(`SELECT claimed_by FROM registers WHERE id = ?`, [register])
    expect(held?.claimed_by).toBe(BACK_RESTORED)

    // Paired again since, and run again on the next start: the new peer stays.
    await db.execute(`INSERT INTO sync_peers (device_id, created_at) VALUES (?, ?)`, [SHOP, '2026-09-26T11:00:00.000Z'])
    const again = await as({ id: BACK_RESTORED, db }, () => adoptRestoredIdentity(db, { replaces: BACK, at }))
    expect(again).toEqual({ counters: 0, peersForgotten: 0 })
    expect(await db.get(`SELECT 1 FROM sync_peers WHERE device_id = ?`, [SHOP])).toBeDefined()
    await db.close()
  })
})
