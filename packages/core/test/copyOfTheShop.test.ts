import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { syncWith, takeCopy, type CopyHost, type CopyMaker } from '../src/services/sync.js'
import { handleSyncRequest, offerPairing, withdrawPairing } from '../src/services/syncServer.js'
import {
  httpTransport, joinByCopy, pairWith, pairedPeers, requestCopy,
} from '../src/services/syncClient.js'
import { mainTill, tillRole } from '../src/services/sync/layout.js'
import { NOT_REPLICATED } from '../src/domain/replicaShape.js'
import { handleCopy } from '../src/services/syncServer/copy.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { openDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { bootstrap } from '../src/services/bootstrap.js'
import { makeProduct, emptyDb } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * A new till takes a copy of the main's database, not the shop through the
 * feed (`docs/specs/one-main-till.md`, *Joining*; `sync/copy.ts`).
 *
 * On real files, through the real routes, and with the two SQL files the app's
 * Rust runs (`packages/core/sql`), read from disk -- so the statements proved
 * here are the statements that run. What the test plays itself is only what
 * Rust does around them: `VACUUM INTO`, the bytes on the wire, and the swap.
 */

const SQL = join(process.cwd(), 'packages/core/sql')
const PREPARE = readFileSync(join(SQL, 'prepare-copy.sql'), 'utf8')
const CARRY = readFileSync(join(SQL, 'carry-over-after-copy.sql'), 'utf8')

const MAIN = '11111111-1111-4111-8111-111111111111'
const T1 = '22222222-2222-4222-8222-222222222222'

let dir: string
let main: { db: SqlDriver; server: Server; url: string; adminId: string }
let t1Path: string
let t1: SqlDriver
const made = new Map<string, string>()

async function as<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(id)
  try { return await fn() } finally { setDeviceId(before) }
}

/** The main's half, as `shop_copy.rs` does it. */
const maker: CopyMaker = {
  async make() {
    const token = `t${made.size}`
    const path = join(dir, `copy-${token}.db`)
    await main.db.execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
    const copy = new Database(path)
    const head = (copy.prepare(
      `SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'change_feed'), 0) AS h`,
    ).get() as { h: number }).h
    copy.exec(PREPARE)
    copy.exec('VACUUM')
    copy.close()
    made.set(token, path)
    return { token, bytes: statSync(path).size, sha256: sha(path), feedHead: head }
  },
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The joining half: fetch (here, read the file) and install, as Rust does. */
const host: CopyHost = {
  async download(copy) {
    const path = made.get(copy.token)!
    expect(sha(path)).toBe(copy.sha256)
    return path
  },
  async install(path, plan) {
    await t1.close()
    const db = new Database(path)
    db.prepare('ATTACH DATABASE ? AS prev').run(t1Path)
    db.transaction(() => {
      db.exec(CARRY)
      db.prepare('UPDATE sync_peers SET their_cursor = ? WHERE device_id = ?').run(plan.feedHead, plan.mainDevice)
    })()
    db.exec('DETACH DATABASE prev')
    db.close()
    t1Path = path
    t1 = openDatabase(path)
  },
}

async function serve(id: string, db: SqlDriver): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const before = deviceId()
        setDeviceId(id)
        try {
          const answer = await handleSyncRequest(db, {
            path: req.url ?? '/', body, auth: (req.headers['x-shopos-auth'] as string | undefined) ?? null,
          }, undefined, { keys: TEST_KEYS, copies: maker })
          res.writeHead(answer.status, { 'content-type': 'application/json' })
          res.end(answer.body)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 'SERVER_ERROR', message: String(err) }))
        } finally {
          setDeviceId(before)
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

beforeEach(async () => {
  withdrawPairing()
  made.clear()
  dir = mkdtempSync(join(tmpdir(), 'shopos-copy-'))
  const db = openDatabase(join(dir, 'main.db'))
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Copy Shop' })
  const adminId = 'admin-of-the-copy-shop'
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, seed.roleIds['Admin']!, now, now],
  )
  await licenseTill(db, 'multi')
  main = { db, adminId, ...(await serve(MAIN, db)) }
  for (let i = 0; i < 30; i++) await as(MAIN, () => makeProduct(db, { name: `Before ${i}` }))

  t1Path = join(dir, 't1.db')
  t1 = openDatabase(t1Path)
  await migrate(t1, MIGRATIONS)
})

afterEach(async () => {
  joinByCopy(false)
  setDeviceId(null)
  withdrawPairing()
  await new Promise<void>((r) => main.server.close(() => r()))
  await main.db.close()
  await t1.close()
  rmSync(dir, { recursive: true, force: true })
})

async function joinMain(): Promise<void> {
  const code = await as(MAIN, async () => offerPairing())
  await as(T1, () => pairWith(t1, main.url, code, 'T1'))
}

const feedSize = async (db: SqlDriver) =>
  (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM change_feed'))!.n

describe('the two statements a copy is made and installed with', () => {
  it('handle every table that is true of a machine rather than of the shop', () => {
    /* `product_stock` is derived from the ledger the copy carries; the audit
       log is append-only and travels, each till adding its own alongside. */
    const ownTables = Object.keys(NOT_REPLICATED).filter((t) => t !== 'product_stock' && t !== 'audit_log')
    for (const table of ownTables) {
      expect(PREPARE, `prepare-copy.sql empties ${table}`).toMatch(new RegExp(`DELETE FROM ${table};|UPDATE ${table}\\b`))
      expect(CARRY, `carry-over-after-copy.sql brings ${table} across`).toContain(`main.${table}`)
    }
  })
})

describe('a till joining by copy', () => {
  it('leaves the main\'s feed unseeded, so no till already paired is sent the shop again', async () => {
    joinByCopy(true)
    const before = await feedSize(main.db)
    await joinMain()
    expect(await feedSize(main.db)).toBe(before)
  })

  it('arrives with the whole shop, and its first round moves only what came after', async () => {
    joinByCopy(true)
    await joinMain()
    const peer = (await pairedPeers(t1))[0]!

    const done = await as(T1, () => takeCopy(
      t1, { deviceId: MAIN, baseUrl: main.url },
      async () => httpTransport(peer).hello(await mainTill(t1)),
      () => requestCopy(peer),
      host,
    ))
    expect(done).toEqual({ ok: true })

    expect((await t1.get<{ n: number }>(`SELECT COUNT(*) AS n FROM products WHERE name LIKE 'Before %'`))!.n).toBe(30)
    expect(await as(T1, () => tillRole(t1)), 'still a till of the same main').toBe('till')

    await as(MAIN, () => makeProduct(main.db, { name: 'After the copy' }))
    const round = await as(T1, () => syncWith(t1, httpTransport(peer), null))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.received, 'one product, not the shop').toBe(1)
    expect(await t1.get(`SELECT 1 FROM products WHERE name = 'After the copy'`)).toBeTruthy()
  })

  it('refuses when this till holds something the main has not received', async () => {
    joinByCopy(true)
    await joinMain()
    const peer = (await pairedPeers(t1))[0]!
    // A till that has been set up and has written something of its own.
    await t1.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('shop_id', 'x', ?)
                      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [new Date().toISOString()])
    await as(T1, () => makeProduct(t1, { name: 'Only here' }))

    let asked = false
    const done = await as(T1, () => takeCopy(
      t1, { deviceId: MAIN, baseUrl: main.url },
      async () => httpTransport(peer).hello(await mainTill(t1)),
      async () => { asked = true; return requestCopy(peer) },
      host,
    ))
    expect(done).toEqual({ ok: false, code: 'HOLDS_UNSENT' })
    expect(asked, 'nothing was asked of the main').toBe(false)
  })
})

describe('a copy', () => {
  it('is handed out only by the main, and only by a host that can take one', async () => {
    const other = await emptyDb()
    await other.execute(`UPDATE sync_state SET main_device = 'someone-else', main_epoch = 1 WHERE id = 1`)
    const fromATill = await as(MAIN, () => handleCopy(other, T1, { copies: maker }))
    expect(fromATill.status).toBe(409)
    expect(JSON.parse(fromATill.body)).toEqual({ code: 'NOT_THE_MAIN' })

    await other.execute(`UPDATE sync_state SET main_device = ?, main_epoch = 1 WHERE id = 1`, [MAIN])
    const noHost = await as(MAIN, () => handleCopy(other, T1, {}))
    expect(noHost.status, 'a host with no way to take a copy says so').toBe(501)
    await other.close()
  })
})
