import { createHash, timingSafeEqual, type webcrypto } from 'node:crypto'
import type { SqlDriver } from '@shopos/core'
import type { OtpChannel } from './otp/channel.js'
import {
  startOtp, verifyOtp, accountForSession, revokeSession, normalisePhone,
} from './auth/otp.js'
import { currentLicence, issueLicence, noteDevice, tillsSeen } from './licences.js'
import { isTier } from '@shopos/core/licence'
import type { AddressThrottle } from './auth/throttle.js'
import { bearer, decoded, ok, bad, unauthorised } from './reply.js'
import { supportRoutes } from './routes/support.js'
import { dataRoutes } from './routes/data.js'
import { switchRoutes } from './routes/switches.js'
import { releaseHealth } from './health/releases.js'
import type { Role } from './console/vendor.js'

/**
 * The portal's HTTP surface, as a function from request to response.
 *
 * A plain function rather than a framework, and no dependency: there are nine
 * routes, the product's whole point is that the important half runs with the
 * line down, and a web framework in this repository would be the largest
 * thing in it by weight for the least important part of it. `server.ts` binds
 * this to `node:http`; the tests call it directly, which is why they need no
 * port and no teardown.
 *
 * ## The device header
 *
 * `X-ShopOS-Device` on the licence route records which till asked. It is a
 * count for a conversation about what a shop has grown into. It is not
 * checked, not enforced, and a till that does not send it is served
 * identically.
 */

export const DEVICE_HEADER = 'x-shopos-device'
export const VERSION_HEADER = 'x-shopos-version'

export interface PortalRequest {
  method: string
  /** Path only, no query string. */
  path: string
  query: URLSearchParams
  headers: Record<string, string | undefined>
  /** Parsed JSON body, or null. */
  body: unknown
  /** The socket's address, for the per-address limit on sign-in codes. Absent in tests that do not say. */
  remoteAddress?: string | null
}

export interface PortalResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface PortalDeps {
  db: SqlDriver
  channel: OtpChannel
  /** Null when no signing key is configured: the licence routes then say so. */
  signingKey: webcrypto.CryptoKey | null
  kid: string
  /**
   * A shared secret for the issuing route, since there is no admin UI yet.
   * Null disables the route rather than leaving it open.
   */
  adminToken: string | null
  /** Development only: lets `auth/start` return the code in its response. */
  exposeCodes?: boolean
  /** How many codes one address may ask for. See `auth/throttle.ts`. */
  throttle?: AddressThrottle
  /** Phones that may use the console, and as what (`console/vendor.ts`). Absent: nobody. */
  vendors?: ReadonlyMap<string, Role>
  /** Where data sent to support is kept (`data/`). Absent: uploads are refused. */
  filesDir?: string | null
  now?: () => Date
}

export async function handle(
  deps: PortalDeps, request: PortalRequest,
): Promise<PortalResponse> {
  const now = deps.now?.() ?? new Date()
  const { method, path } = request

  if (method === 'GET' && path === '/v1/health') {
    return ok({
      ok: true,
      /* Says what is wired and what is a placeholder, because the first
         question about a fresh deployment is which half of it is real. */
      licensing: deps.signingKey === null ? 'no signing key' : `signing as ${deps.kid}`,
      otpChannel: deps.channel.name,
      issuing: deps.adminToken === null ? 'disabled' : 'enabled',
    })
  }

  /* ── signing in ───────────────────────────────────────────────────── */

  if (method === 'POST' && path === '/v1/auth/start') {
    const phone = field(request.body, 'phone')
    if (phone === null) return bad('a phone number is required')

    const wait = deps.throttle?.take(request.remoteAddress, now) ?? null
    if (wait !== null) {
      return {
        status: 429,
        body: { error: 'TOO_MANY_FROM_HERE', retryAfterSeconds: wait },
        headers: { 'Retry-After': String(wait) },
      }
    }

    const started = await startOtp(
      deps.db,
      { channel: deps.channel, ...(deps.exposeCodes === true ? { exposeCodes: true } : {}) },
      { phone, now },
    )

    if (started.ok) {
      return ok({
        challengeId: started.challengeId,
        expiresAt: started.expiresAt,
        channel: started.channel,
        ...(started.devCode === null ? {} : { devCode: started.devCode }),
      })
    }

    switch (started.code) {
      case 'TOO_SOON':
      case 'TOO_MANY':
        return {
          status: 429,
          body: { error: started.code, retryAfterSeconds: started.retryAfterSeconds },
          headers: { 'Retry-After': String(started.retryAfterSeconds) },
        }
      case 'UNREACHABLE':
        return { status: 422, body: { error: started.code, detail: started.detail } }
      case 'CHANNEL_DOWN':
        return { status: 503, body: { error: started.code, detail: started.detail } }
      default:
        return { status: 400, body: { error: started.code, detail: started.detail } }
    }
  }

  if (method === 'POST' && path === '/v1/auth/verify') {
    const challengeId = field(request.body, 'challengeId')
    const code = field(request.body, 'code')
    if (challengeId === null || code === null) return bad('challengeId and code are required')

    const verified = await verifyOtp(deps.db, { challengeId, code, now })
    if (!verified.ok) {
      /* Every failure is 401 with its own code. The status does not
         distinguish a wrong code from an expired one, and the body does,
         because the person needs to know which and an attacker learns
         nothing from it that five attempts would not tell them. */
      return { status: 401, body: { error: verified.code, ...rest(verified) } }
    }

    return ok({
      token: verified.session.token,
      expiresAt: verified.session.expiresAt,
      account: publicAccount(verified.account),
    })
  }

  if (method === 'POST' && path === '/v1/auth/sign-out') {
    const token = bearer(request)
    if (token !== null) await revokeSession(deps.db, token, now)
    // Always 204: whether that was a real session is not the caller's business.
    return { status: 204, body: null }
  }

  if (method === 'GET' && path === '/v1/me') {
    const account = await signedIn(deps, request, now)
    if (account === null) return unauthorised()
    return ok({ account: publicAccount(account) })
  }

  /* ── licences ─────────────────────────────────────────────────────── */

  if (method === 'GET' && path.startsWith('/v1/licence/')) {
    const shopId = decoded(path.slice('/v1/licence/'.length))
    if (shopId === null || shopId === '') return bad('a shop id is required')

    const device = request.headers[DEVICE_HEADER]
    if (device !== undefined && device !== '') {
      await noteDevice(deps.db, {
        shopId,
        deviceId: device,
        version: request.headers[VERSION_HEADER] ?? null,
        now,
      })
    }

    const licence = await currentLicence(deps.db, shopId)
    /* 404 rather than an empty token: "this shop has no licence" and "this
       licence is empty" are different things at the counter, and a till that
       cannot tell them apart shows the wrong card. */
    if (licence === null) return { status: 404, body: { error: 'NO_LICENCE', shopId } }

    return ok({
      token: licence.token,
      tier: licence.tier,
      paidThrough: licence.paidThrough,
      tills: licence.tills,
      issuedAt: licence.issuedAt,
    })
  }

  if (method === 'POST' && path === '/v1/licences') {
    if (deps.adminToken === null) {
      return { status: 404, body: { error: 'ISSUING_DISABLED' } }
    }
    if (!sameSecret(bearer(request), deps.adminToken)) return unauthorised()
    if (deps.signingKey === null) {
      return { status: 503, body: { error: 'NO_SIGNING_KEY', detail: 'set SHOPOS_LICENCE_KEY' } }
    }

    const shopId = field(request.body, 'shopId')
    const tier = field(request.body, 'tier')
    const paidThrough = field(request.body, 'paidThrough')
    const tills = numberField(request.body, 'tills') ?? 1

    if (shopId === null) return bad('shopId is required')
    if (tier === null || !isTier(tier)) return bad('tier is single, cloud or branches')

    const issued = await issueLicence(deps.db, deps.signingKey, {
      shopId, tier, paidThrough, tills, kid: deps.kid, issuedBy: 'admin-token', now,
    })
    if (!issued.ok) return { status: 400, body: { error: issued.code, detail: issued.detail } }

    return { status: 201, body: { token: issued.licence.token, id: issued.licence.id } }
  }

  if (method === 'GET' && path.startsWith('/v1/shops/') && path.endsWith('/tills')) {
    const account = await signedIn(deps, request, now)
    if (account === null) return unauthorised()

    const shopId = decoded(path.slice('/v1/shops/'.length, -'/tills'.length))
    if (shopId === null) return bad('a shop id is required')
    const owned = await deps.db.get<{ id: string }>(
      'SELECT id FROM shops WHERE id = ? AND account_id = ?', [shopId, account.id],
    )
    if (owned === undefined) return { status: 404, body: { error: 'NO_SHOP' } }

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000)
    return ok({ shopId, tillsSeen: await tillsSeen(deps.db, shopId, thirtyDaysAgo) })
  }

  /* Each release's crash figures, for `tools/release.ts target` on the
     vendor's machine before it widens a rollout. Behind the admin token, as
     issuing is: a script asks, not a person. */
  if (method === 'GET' && path === '/v1/releases') {
    if (deps.adminToken === null) return { status: 404, body: { error: 'ADMIN_TOKEN_NOT_SET' } }
    if (!sameSecret(bearer(request), deps.adminToken)) return unauthorised()
    return ok({ releases: await releaseHealth(deps.db) })
  }

  /* Health reports from tills, and the vendor's console (`routes/support.ts`). */
  const support = await supportRoutes(deps, request, now)
  if (support !== null) return support
  const data = await dataRoutes(deps, request, now)
  if (data !== null) return data
  const switches = await switchRoutes(deps, request)
  if (switches !== null) return switches

  return { status: 404, body: { error: 'NO_ROUTE', method, path } }
}

/* ── the small stuff ─────────────────────────────────────────────────── */

async function signedIn(deps: PortalDeps, request: PortalRequest, now: Date) {
  const token = bearer(request)
  return token === null ? null : accountForSession(deps.db, token, now)
}

/**
 * The admin token, compared without saying how much of a guess was right.
 * `!==` stops at the first differing character, and the time that takes is
 * what an attacker measures. Both sides are hashed first so the lengths agree.
 */
function sameSecret(given: string | null, expected: string): boolean {
  if (given === null) return false
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

function publicAccount(account: { id: string; phone: string; name: string | null }) {
  return { id: account.id, phone: account.phone, name: account.name }
}

function field(body: unknown, name: string): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numberField(body: unknown, name: string): number | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'number' ? value : null
}

/** The extra fields a failure carries, without `ok` and `code`. */
function rest(result: Record<string, unknown>): Record<string, unknown> {
  const { ok: _ok, code: _code, ...others } = result
  return others
}

export { normalisePhone }
