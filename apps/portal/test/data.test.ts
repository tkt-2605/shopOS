import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle } from '../src/http.js'
import { sweepUploads, KEEP_DAYS } from '../src/data/store.js'
import { parseVendors } from '../src/console/vendor.js'
import { testPortal, type TestPortal } from './support.js'

/**
 * A shop's data arriving at the portal: in parts, over a line that drops,
 * checked against what the till said it sent, handed only to the vendor, and
 * deleted on its date. The bytes here stand in for ciphertext -- the portal
 * never sees anything else.
 */

const SHOP = '0192f4a1-77aa-7bcd-8000-000000000001'
const VENDOR = '+919876543210'
const NOW = new Date('2026-10-16T03:00:00Z')

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup) await c()
  cleanup = []
})

async function portal(role = 'admin'): Promise<TestPortal & { filesDir: string }> {
  const p = await testPortal({ now: () => NOW })
  const filesDir = mkdtempSync(join(tmpdir(), 'shopos-portal-files-'))
  cleanup.push(async () => { await p.close(); rmSync(filesDir, { recursive: true, force: true }) })
  return { ...p, vendors: parseVendors(`${VENDOR}:${role}`), filesDir }
}

function call(p: TestPortal, method: string, path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  return handle(p, {
    method, path, query: new URLSearchParams(), headers: token ? { authorization: `Bearer ${token}` } : {}, body,
  }) as Promise<{ status: number; body: any }>
}

const file = randomBytes(300_000)
const sha = createHash('sha256').update(file).digest('hex')

function start(p: TestPortal, key?: string, bytes = file.length, sum = sha) {
  return call(p, 'POST', `/v1/shops/${SHOP}/data`, {
    shopId: SHOP, deviceId: 'till-a', bytes, sha256: sum, anonymised: true, note: 'bills not crossing',
  }, key)
}

function part(p: TestPortal, id: string, key: string, offset: number, data: Buffer) {
  return call(p, 'POST', `/v1/data/${id}/part`, { offset, data: data.toString('base64') }, key)
}

async function signIn(p: TestPortal): Promise<string> {
  const s = await call(p, 'POST', '/v1/auth/start', { phone: VENDOR })
  const v = await call(p, 'POST', '/v1/auth/verify', { challengeId: s.body.challengeId, code: p.channel.last()!.code })
  return v.body.token
}

async function sendAll(p: TestPortal, key: string, id: string, from = 0, size = 100_000) {
  for (let at = from; at < file.length; at += size) {
    const r = await part(p, id, key, at, file.subarray(at, at + size))
    expect(r.status).toBe(200)
  }
}

describe('a till sending its data', () => {
  it('arrives in parts, and carries on from where a broken upload stopped', async () => {
    const p = await portal()
    const first = await start(p)
    expect(first.status).toBe(200)
    const key = first.body.key
    const id = first.body.uploadId

    await part(p, id, key, 0, file.subarray(0, 100_000))
    // The line drops. Asking again finds the same upload and where it got to.
    const again = await start(p, key)
    expect(again.body).toEqual({ uploadId: id, received: 100_000 })

    await sendAll(p, key, id, 100_000)
    const last = await call(p, 'POST', `/v1/data/${id}/part`, { offset: file.length, data: 'AA==' }, key)
    expect(last.status).toBe(200)
    expect(last.body).toEqual({ received: file.length, done: true })
  })

  it('answers a part in the wrong place with where to start', async () => {
    const p = await portal()
    const { body } = await start(p)
    await part(p, body.uploadId, body.key, 0, file.subarray(0, 1000))
    const wrong = await part(p, body.uploadId, body.key, 5000, file.subarray(5000, 6000))
    expect(wrong.status).toBe(409)
    expect(wrong.body.received).toBe(1000)
  })

  it('throws away a file that is not what the till said it sent, and starts again', async () => {
    const p = await portal()
    const { body } = await start(p, undefined, file.length, 'a'.repeat(64))
    for (let at = 0; at < file.length; at += 100_000) {
      const r = await part(p, body.uploadId, body.key, at, file.subarray(at, at + 100_000))
      if (at + 100_000 >= file.length) {
        expect(r.status).toBe(422)
        expect(r.body.received).toBe(0)
      }
    }
  })

  it('takes parts only from the till that started it', async () => {
    const p = await portal()
    const { body } = await start(p)
    expect((await part(p, body.uploadId, 'someone-else', 0, file.subarray(0, 10))).status).toBe(401)
    expect((await start(p)).status).toBe(401) // the till has a key now, and must show it
  })

  it('is refused when the portal has nowhere to keep it', async () => {
    const p = { ...(await portal()), filesDir: null }
    expect((await start(p as unknown as TestPortal)).status).toBe(503)
  })
})

describe('the vendor receiving it', () => {
  it('downloads exactly the bytes sent, and the support log says who', async () => {
    const p = await portal('support')
    const { body } = await start(p)
    await sendAll(p, body.key, body.uploadId)
    const token = await signIn(p)

    // A shop that has sent data before any health report still has a page.
    const shop = await call(p, 'GET', `/v1/console/shops/${SHOP}`, null, token)
    expect(shop.body.data[0]).toMatchObject({ id: body.uploadId, anonymised: true, note: 'bills not crossing' })
    const got = await call(p, 'GET', `/v1/console/data/${body.uploadId}`, null, token) as { status: number; body: Buffer }
    expect(got.status).toBe(200)
    expect(Buffer.from(got.body).equals(file)).toBe(true)
    const log = await p.db.query<{ action: string; detail: string }>('SELECT action, detail FROM support_log')
    expect(log).toEqual([{ action: 'view_shop', detail: null }, { action: 'download_data', detail: body.uploadId }])
  })

  it('is not for a view-only vendor', async () => {
    const p = await portal('view')
    const { body } = await start(p)
    await sendAll(p, body.key, body.uploadId)
    expect((await call(p, 'GET', `/v1/console/data/${body.uploadId}`, null, await signIn(p))).status).toBe(403)
  })

  it('is deleted after thirty days, and the record of it stays', async () => {
    const p = await portal()
    const { body } = await start(p)
    await sendAll(p, body.key, body.uploadId)
    const path = join(p.filesDir, `${body.uploadId}.sod`)
    expect(existsSync(path)).toBe(true)

    expect(await sweepUploads(p.db, p.filesDir, new Date(NOW.getTime() + (KEEP_DAYS - 1) * 86_400_000))).toBe(0)
    expect(await sweepUploads(p.db, p.filesDir, new Date(NOW.getTime() + (KEEP_DAYS + 1) * 86_400_000))).toBe(1)
    expect(existsSync(path)).toBe(false)
    const row = await p.db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM data_uploads WHERE id = ?', [body.uploadId])
    expect(row?.deleted_at).not.toBeNull()
    expect((await call(p, 'GET', `/v1/console/data/${body.uploadId}`, null, await signIn(p))).status).toBe(404)
  })
})
