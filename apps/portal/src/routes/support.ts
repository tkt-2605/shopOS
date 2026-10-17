import type { PortalDeps, PortalRequest, PortalResponse } from '../http.js'
import { accountForSession } from '../auth/otp.js'
import { bearer, decoded, ok, bad, unauthorised, forbidden, html } from '../reply.js'
import { readReport } from '../health/read.js'
import { alertsFor } from '../health/alerts.js'
import { receiveReport, latestPerTill, historyOf, reportBody, forgetKey, logSupport } from '../health/store.js'
import { mayDo, type Role } from '../console/vendor.js'
import { CONSOLE_PAGE } from '../console/page.js'
import { uploadsOf, uploadById, readUpload } from '../data/store.js'
import { setBoard, boardFrom, latestBoard } from './switches.js'
import { releaseHealth } from '../health/releases.js'

/*
 * Health reports in from the tills, and the vendor's console over them.
 *
 * The report route is open to every till of every shop, free ones included --
 * it is how the vendor sees a shop at all -- and proves the till by the key
 * the till was given on its first report (`health/store.ts`). The console
 * routes need a signed-in vendor (`console/vendor.ts`), and every look at one
 * shop is written to the support log.
 */

/** Where a till sends its report. `server.ts` lets this path carry a larger body. */
export const HEALTH_PATH = /^\/v1\/shops\/([^/]+)\/health$/

export async function supportRoutes(
  deps: PortalDeps, request: PortalRequest, now: Date,
): Promise<PortalResponse | null> {
  const { method, path } = request

  const health = HEALTH_PATH.exec(path)
  if (method === 'POST' && health) {
    const shopId = decoded(health[1]!)
    const read = readReport(request.body)
    if (!read.ok) return bad(read.detail)
    if (shopId !== read.report.shopId) return bad('the shop in the address is not the shop in the report')

    const received = await receiveReport(deps.db, {
      report: read.report, body: JSON.stringify(request.body), key: bearer(request), now,
    })
    if (!received.ok) return { status: 401, body: { error: received.code } }
    return ok({ received: received.id, ...(received.key === null ? {} : { key: received.key }) })
  }

  if (method === 'GET' && (path === '/console' || path === '/console/')) return html(CONSOLE_PAGE)

  if (!path.startsWith('/v1/console/')) return null

  const vendor = await vendorOf(deps, request, now)
  if (vendor === 'signed_out') return unauthorised()
  // Signed in, as a shop owner: the console is not theirs.
  if (vendor === 'not_vendor') return forbidden()
  const { accountId, role } = vendor

  if (method === 'GET' && path === '/v1/console/fleet') {
    const tills = await latestPerTill(deps.db)
    const alerts = alertsFor(tills, now)
    const shops = new Map<string, { shopId: string; shopName: string | null; tills: unknown[]; alerts: Record<string, number> }>()
    for (const t of tills) {
      const shop = shops.get(t.shopId) ?? { shopId: t.shopId, shopName: t.shopName, tills: [], alerts: { P1: 0, P2: 0, P3: 0 } }
      shop.shopName ??= t.shopName
      shop.tills.push({ deviceId: t.deviceId, version: t.summary.version, receivedAt: t.receivedAt })
      shops.set(t.shopId, shop)
    }
    for (const a of alerts) {
      const shop = shops.get(a.shopId)
      if (shop) shop.alerts[a.severity] = (shop.alerts[a.severity] ?? 0) + 1
    }
    return ok({ role, shops: [...shops.values()], alerts })
  }

  const shop = /^\/v1\/console\/shops\/([^/]+)$/.exec(path)
  if (method === 'GET' && shop) {
    const shopId = decoded(shop[1]!)
    if (shopId === null) return bad('a shop id is required')
    const tills = await latestPerTill(deps.db, shopId)
    const sent = await uploadsOf(deps.db, shopId)
    if (tills.length === 0 && sent.length === 0) return { status: 404, body: { error: 'NO_REPORTS', shopId } }
    await logSupport(deps.db, { accountId, action: 'view_shop', shopId, now })
    return ok({
      shopId,
      shopName: tills.find((t) => t.shopName)?.shopName ?? null,
      alerts: alertsFor(tills, now),
      tills: await Promise.all(tills.map(async (t) => ({
        ...t, history: await historyOf(deps.db, shopId, t.deviceId),
      }))),
      data: sent,
      log: await deps.db.query(
        'SELECT at, account_id AS accountId, action, detail FROM support_log WHERE shop_id = ? ORDER BY at DESC LIMIT 20',
        [shopId],
      ),
    })
  }

  const report = /^\/v1\/console\/reports\/([0-9a-f]+)$/.exec(path)
  if (method === 'GET' && report) {
    const found = await reportBody(deps.db, report[1]!)
    if (found === null) return { status: 404, body: { error: 'NO_REPORT' } }
    await logSupport(deps.db, { accountId, action: 'open_report', shopId: found.shopId, detail: report[1]!, now })
    return ok(JSON.parse(found.body))
  }

  const data = /^\/v1\/console\/data\/([0-9a-f]{32})$/.exec(path)
  if (method === 'GET' && data) {
    // Opening a shop's data is more than reading its health.
    if (!mayDo(role, 'support')) return forbidden()
    const upload = await uploadById(deps.db, data[1]!)
    if (upload === null || upload.completedAt === null || upload.deletedAt !== null || !deps.filesDir) {
      return { status: 404, body: { error: 'NO_DATA' } }
    }
    await logSupport(deps.db, { accountId, action: 'download_data', shopId: upload.shopId, detail: upload.id, now })
    return {
      status: 200,
      body: readUpload(deps.filesDir, upload.id),
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="shopos-data-${upload.shopId.slice(0, 8)}-${upload.id.slice(0, 8)}.sod"`,
      },
    }
  }

  if (method === 'GET' && path === '/v1/console/releases') {
    return ok({ releases: await releaseHealth(deps.db), switches: await latestBoard(deps.db) })
  }

  if (method === 'POST' && path === '/v1/console/switches') {
    if (!mayDo(role, 'admin')) return forbidden()
    const token = boardFrom(request.body)
    if (token === null) return bad('token is the board tools/support/switches.ts printed')
    const set = await setBoard(deps.db, token, accountId, now)
    if (!set.ok) return { status: 409, body: { error: 'NOT_SET', detail: set.detail } }
    await logSupport(deps.db, { accountId, action: 'set_switches', shopId: null, detail: set.issuedAt, now })
    return ok({ issuedAt: set.issuedAt })
  }

  const forget = /^\/v1\/console\/shops\/([^/]+)\/tills\/([^/]+)\/forget-key$/.exec(path)
  if (method === 'POST' && forget) {
    if (!mayDo(role, 'admin')) return forbidden()
    const shopId = decoded(forget[1]!)
    const deviceId = decoded(forget[2]!)
    if (shopId === null || deviceId === null) return bad('a shop and a till are required')
    await forgetKey(deps.db, shopId, deviceId)
    await logSupport(deps.db, { accountId, action: 'forget_key', shopId, detail: deviceId, now })
    return { status: 204, body: null }
  }

  return null
}

async function vendorOf(
  deps: PortalDeps, request: PortalRequest, now: Date,
): Promise<{ accountId: string; role: Role } | 'signed_out' | 'not_vendor'> {
  const token = bearer(request)
  if (token === null) return 'signed_out'
  const account = await accountForSession(deps.db, token, now)
  if (account === null) return 'signed_out'
  const role = deps.vendors?.get(account.phone) ?? null
  return role === null ? 'not_vendor' : { accountId: account.id, role }
}
