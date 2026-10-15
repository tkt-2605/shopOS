import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handle, type PortalRequest } from '../src/http.js'
import { serve } from '../src/server.js'
import { readReport } from '../src/health/read.js'
import { alertsFor, type TillLatest } from '../src/health/alerts.js'
import { digestText, digestDue } from '../src/health/digest.js'
import { runDigest } from '../src/health/runDigest.js'
import { latestPerTill, KEEP_PER_TILL } from '../src/health/store.js'
import { parseVendors } from '../src/console/vendor.js'
import { testPortal, type TestPortal } from './support.js'

/**
 * Health reports in from the tills, the alerts read from them, the morning
 * digest, and the console over all of it.
 *
 * The reports here have the shape a till sends (`report_out.rs`'s portal
 * channel: the health zip's JSON parts, without the logs).
 */

const SHOP = '0192f4a1-77aa-7bcd-8000-000000000001'
const VENDOR = '+919876543210'
const OWNER = '+919811111111'
const NOW = new Date('2026-10-16T03:00:00Z') // 08:30 in India

let open: TestPortal[] = []
let servers: Server[] = []
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  for (const p of open) await p.close()
  open = []
  servers = []
})

async function portal(now = NOW): Promise<TestPortal> {
  const p = await testPortal({ now: () => now })
  const made = { ...p, vendors: parseVendors(`${VENDOR}:admin`) }
  open.push(p)
  return made
}

function hoursAgo(h: number, from = NOW): string {
  return new Date(from.getTime() - h * 3_600_000).toISOString()
}

/** A healthy till's report; `change` breaks what a test is about. */
function report(change: (r: any) => void = () => {}, deviceId = 'dev-a', shopId = SHOP): any {
  const r: any = {
    format: 1, shopId, deviceId, shopName: 'Sri Vidya Stores', generatedAt: hoursAgo(1), appVersion: '0.3.0',
    health: { generated_at: hoursAgo(1), app_version: '0.3.0', problems: [] },
    checks: {
      schema_version: 72,
      integrity: [{ quick_check: 'ok' }],
      foreign_key_problems: 0,
      documents: { submitted_bills_without_books: [{ n: 0 }] },
      sync: {
        peers: [{ device_id: 'dev-b', label: 'Front', last_agreed_at: hoursAgo(1), last_error: null, clock_skew_ms: 900 }],
        set_aside: [],
      },
    },
    app: { licence: { state: 'active', paidThrough: null, problem: null, clockUnreliable: false }, discrepancies: [] },
    faults: { sessions: { '0.3.0': { started: 5, clean: 5, panicked: 0, unclean: 0 } }, errors: [] },
  }
  change(r)
  return r
}

function post(p: TestPortal, body: unknown, key?: string, shopId = SHOP): Promise<{ status: number; body: any }> {
  return handle(p, {
    method: 'POST', path: `/v1/shops/${encodeURIComponent(shopId)}/health`, query: new URLSearchParams(),
    headers: key ? { authorization: `Bearer ${key}` } : {}, body,
  }) as Promise<{ status: number; body: any }>
}

function get(p: TestPortal, path: string, token?: string, method = 'GET'): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  const request: PortalRequest = {
    method, path, query: new URLSearchParams(), headers: token ? { authorization: `Bearer ${token}` } : {}, body: null,
  }
  return handle(p, request) as Promise<{ status: number; body: any }>
}

async function signIn(p: TestPortal, phone: string): Promise<string> {
  const started = await get(p, '/v1/auth/start', undefined, 'POST')
  expect(started.status).toBe(400) // no phone: the route is real
  const start = await handle(p, { method: 'POST', path: '/v1/auth/start', query: new URLSearchParams(), headers: {}, body: { phone } }) as any
  const code = p.channel.last()!.code
  const done = await handle(p, {
    method: 'POST', path: '/v1/auth/verify', query: new URLSearchParams(), headers: {},
    body: { challengeId: start.body.challengeId, code },
  }) as any
  return done.body.token
}

function till(change: (r: any) => void = () => {}, receivedAt = hoursAgo(1), deviceId = 'dev-a'): TillLatest {
  const read = readReport(report(change, deviceId))
  if (!read.ok) throw new Error(read.detail)
  return { shopId: SHOP, deviceId, receivedAt, summary: read.report.summary }
}

describe('reading a report', () => {
  it('finds what the rules need in what a till sends', () => {
    const read = readReport(report())
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.report.summary).toMatchObject({
      version: '0.3.0', schemaVersion: 72, integrityOk: true, booksMissing: 0, setAsideWaiting: 0,
      runs: { started: 5, clean: 5, panicked: 0, unclean: 0 }, errorKinds: 0,
    })
    expect(read.report.summary.peers[0]).toMatchObject({ deviceId: 'dev-b', label: 'Front', clockSkewMs: 900 })
  })

  it('reads a figure it cannot find as unknown, never as fine', () => {
    const read = readReport({ shopId: SHOP, deviceId: 'dev-a' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.report.summary.integrityOk).toBeNull()
    expect(read.report.summary.booksMissing).toBeNull()
    expect(read.report.summary.runs).toBeNull()
  })

  it('refuses something that is not a report', () => {
    expect(readReport('hello').ok).toBe(false)
    expect(readReport({ deviceId: 'x' }).ok).toBe(false)
  })
})

describe('a till sending its report', () => {
  it('is given a key the first time, and must show it every time after', async () => {
    const p = await portal()
    const first = await post(p, report())
    expect(first.status).toBe(200)
    expect(first.body.key).toMatch(/^[\w-]{40,}$/)

    expect((await post(p, report())).status).toBe(401)
    expect((await post(p, report(), 'not-the-key')).status).toBe(401)
    const again = await post(p, report(), first.body.key)
    expect(again.status).toBe(200)
    expect(again.body.key).toBeUndefined()

    // Only a hash of the key is kept.
    const rows = await p.db.query('SELECT * FROM health_keys')
    expect(JSON.stringify(rows)).not.toContain(first.body.key)
  })

  it('cannot file a report under another shop', async () => {
    const p = await portal()
    expect((await post(p, report(), undefined, 'some-other-shop')).status).toBe(400)
  })

  it('keeps a month of reports per till and no more', async () => {
    const p = await portal()
    const { body } = await post(p, report())
    for (let i = 0; i < KEEP_PER_TILL + 5; i += 1) await post(p, report(), body.key)
    const n = await p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM health_reports')
    expect(n?.n).toBe(KEEP_PER_TILL)
  })

  it('takes a report far larger than other routes take, over a real socket', async () => {
    const p = await portal()
    const server = await serve(p, { port: 0 })
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const big = report((r) => { r.checks.row_counts = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`table_${i}_${'x'.repeat(40)}`, i])) })
    expect(JSON.stringify(big).length).toBeGreaterThan(64 * 1024)

    const health = await fetch(`${base}/v1/shops/${SHOP}/health`, { method: 'POST', body: JSON.stringify(big) })
    expect(health.status).toBe(200)
    const elsewhere = await fetch(`${base}/v1/auth/start`, { method: 'POST', body: JSON.stringify(big) })
    expect(elsewhere.status).toBe(413)
  })
})

describe('the alert rules', () => {
  const rules = (tills: TillLatest[]) => alertsFor(tills, NOW).map((a) => `${a.severity} ${a.rule}`)

  it('say nothing about a healthy shop', () => {
    expect(rules([till(), till(() => {}, hoursAgo(1), 'dev-b')])).toEqual([])
  })

  it('call a broken database and missing books P1', () => {
    expect(rules([till((r) => { r.checks.integrity = [{ quick_check: 'page 4: btree broken' }] })])).toContain('P1 integrity')
    expect(rules([till((r) => { r.checks.documents.submitted_bills_without_books = [{ n: 2 }] })])).toContain('P1 books')
  })

  it('call a till quiet after two days, and only P3: it may simply be off', () => {
    expect(rules([till(() => {}, hoursAgo(72))])).toEqual(['P3 quiet'])
  })

  it('call sync stuck only when both tills are reporting', () => {
    const stale = (r: any) => { r.checks.sync.peers[0].last_agreed_at = hoursAgo(30); r.checks.sync.peers[0].last_error = 'connection refused' }
    expect(rules([till(stale), till(() => {}, hoursAgo(1), 'dev-b')])).toContain('P2 sync_stuck')
    // dev-b has not reported for days: it is off, not stuck.
    expect(rules([till(stale), till(() => {}, hoursAgo(72), 'dev-b')])).not.toContain('P2 sync_stuck')
  })

  it('call set-aside records P2 once they have waited a day', () => {
    const waiting = (h: number) => (r: any) => { r.checks.sync.set_aside = [{ at: hoursAgo(h), acknowledged: 0 }] }
    expect(rules([till(waiting(30))])).toContain('P2 set_aside')
    expect(rules([till(waiting(2))])).not.toContain('P2 set_aside')
  })

  it('tell a crash from a power cut', () => {
    const cut = (r: any) => { r.faults.sessions['0.3.0'] = { started: 9, clean: 5, panicked: 0, unclean: 4 } }
    expect(rules([till(cut)])).toEqual([])
    expect(rules([till((r) => { r.faults.sessions['0.3.0'].panicked = 1 })])).toContain('P2 crash')
    expect(rules([till((r) => { r.faults.sessions['0.3.0'].panicked = 3 })])).toContain('P1 crash')
  })

  it('warn about a licence ending, a clock off, double entries and mixed versions', () => {
    expect(rules([till((r) => { r.app.licence.paidThrough = '2026-10-20' })])).toContain('P2 licence')
    expect(rules([till((r) => { r.app.licence.problem = 'BAD_SIGNATURE' })])).toContain('P2 licence')
    expect(rules([till((r) => { r.checks.sync.peers[0].clock_skew_ms = 9 * 60_000 })])).toContain('P3 clock')
    expect(rules([till((r) => { r.app.discrepancies = [{ kind: 'paid_twice' }] })])).toContain('P3 discrepancy')
    expect(rules([till(), till((r) => { r.appVersion = '0.2.21'; r.health.app_version = '0.2.21' }, hoursAgo(1), 'dev-b')]))
      .toContain('P3 versions')
  })

  it('put the urgent first', () => {
    const all = alertsFor([till((r) => {
      r.app.discrepancies = [{ kind: 'paid_twice' }]
      r.checks.integrity = [{ quick_check: 'bad' }]
    })], NOW)
    expect(all[0]!.severity).toBe('P1')
  })
})

describe('the morning digest', () => {
  it('lists the urgent by shop and only counts the rest', () => {
    const alerts = alertsFor([till((r) => {
      r.checks.documents.submitted_bills_without_books = [{ n: 1 }]
      r.app.discrepancies = [{ kind: 'paid_twice' }]
    })], NOW)
    const text = digestText(alerts, { shops: 1, tills: 1, names: new Map([[SHOP, 'Sri Vidya Stores']]) })
    expect(text).toContain('Sri Vidya Stores (0192f4a1)')
    expect(text).toContain('P1 till dev-a: 1 submitted bill(s) have no entries in the books.')
    expect(text).toContain('And 1 smaller thing(s) on the console.')
    expect(text).not.toContain('paid_twice')
  })

  it('goes after eight in the morning in India, once a day', () => {
    expect(digestDue(new Date('2026-10-16T02:00:00Z'), null)).toBe(false) // 07:30 IST
    expect(digestDue(new Date('2026-10-16T02:31:00Z'), null)).toBe(true)
    expect(digestDue(new Date('2026-10-16T02:31:00Z'), '2026-10-16')).toBe(false)
  })

  it('is sent once, and the support log says when', async () => {
    const p = await portal()
    await post(p, report())
    const sent: string[] = []
    const fetcher = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).text)
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    const bot = { token: '123:abc', chat: '42' }

    expect((await runDigest(p.db, bot, { now: NOW, fetcher })).sent).toBe(true)
    expect((await runDigest(p.db, bot, { now: NOW, fetcher })).sent).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Nothing urgent')
    expect(await p.db.get(`SELECT detail FROM support_log WHERE action = 'digest'`)).toEqual({ detail: '2026-10-16' })
  })

  it('never quotes the bot token in an error', async () => {
    const p = await portal()
    const fetcher = (async (url: string) => { throw new Error(`could not reach ${url}`) }) as unknown as typeof fetch
    const result = await runDigest(p.db, { token: '123:secret', chat: '42' }, { now: NOW, fetcher, force: true })
    expect(result.sent).toBe(false)
    expect(JSON.stringify(result)).not.toContain('123:secret')
  })
})

describe('the console', () => {
  it('serves its page with a policy that keeps it to itself', async () => {
    const p = await portal()
    const page = await get(p, '/console')
    expect(page.status).toBe(200)
    expect(page.headers?.['Content-Type']).toContain('text/html')
    expect(page.headers?.['Content-Security-Policy']).toContain("connect-src 'self'")
    expect(String(page.body)).not.toContain('innerHTML')
  })

  it('is closed to the signed out, and to shop owners', async () => {
    const p = await portal()
    expect((await get(p, '/v1/console/fleet')).status).toBe(401)
    expect((await get(p, '/v1/console/fleet', await signIn(p, OWNER))).status).toBe(403)
  })

  it('shows a vendor the fleet, and logs every look at a shop', async () => {
    const p = await portal()
    const key = (await post(p, report((r) => { r.checks.documents.submitted_bills_without_books = [{ n: 1 }] }))).body.key
    await post(p, report(() => {}, 'dev-b'))
    const token = await signIn(p, VENDOR)

    const fleet = await get(p, '/v1/console/fleet', token)
    expect(fleet.status).toBe(200)
    expect(fleet.body.role).toBe('admin')
    expect(fleet.body.shops).toHaveLength(1)
    expect(fleet.body.shops[0].alerts.P1).toBe(1)

    const shop = await get(p, `/v1/console/shops/${SHOP}`, token)
    expect(shop.body.tills).toHaveLength(2)
    const reportId = shop.body.tills[0].history[0].id
    const opened = await get(p, `/v1/console/reports/${reportId}`, token)
    expect(opened.body.shopId).toBe(SHOP)

    const log = await p.db.query<{ action: string }>('SELECT action FROM support_log ORDER BY at')
    expect(log.map((l) => l.action)).toEqual(['view_shop', 'open_report'])
    expect(key).toBeTruthy()
  })

  it('lets an admin forget a till key, so a rebuilt till can start again', async () => {
    const p = await portal()
    await post(p, report())
    expect((await post(p, report())).status).toBe(401)
    const token = await signIn(p, VENDOR)
    expect((await get(p, `/v1/console/shops/${SHOP}/tills/dev-a/forget-key`, token, 'POST')).status).toBe(204)
    expect((await post(p, report())).body.key).toBeTruthy()
    expect((await latestPerTill(p.db)).length).toBe(1)
  })

  it('does not let a view-only vendor forget a key', async () => {
    const p = { ...(await portal()), vendors: parseVendors(`${VENDOR}:view`) }
    const token = await signIn(p, VENDOR)
    expect((await get(p, `/v1/console/shops/${SHOP}/tills/dev-a/forget-key`, token, 'POST')).status).toBe(403)
  })
})
