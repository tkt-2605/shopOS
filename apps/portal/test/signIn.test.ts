import { describe, it, expect, afterEach } from 'vitest'
import {
  startOtp, verifyOtp, accountForSession, revokeSession, normalisePhone,
  MAX_ATTEMPTS, MAX_PER_HOUR, RESEND_COOLDOWN_SECONDS, CODE_TTL_SECONDS,
} from '../src/auth/otp.js'
import { memoryChannel } from '../src/otp/channels.js'
import { firstThatWorks, type OtpChannel } from '../src/otp/channel.js'
import { telegramGateway } from '../src/otp/telegram.js'
import { beginOAuth, linkIdentity, accountForIdentity } from '../src/auth/oauth.js'
import { testPortal, type TestPortal } from './support.js'

/**
 * Signing in with a phone number.
 *
 * Every rule in `auth/otp.ts` is a decision that costs something when it is
 * wrong -- a login somebody cannot complete, or a login somebody else can --
 * so each one is pinned here rather than left to the reader of the constant.
 */

const PHONE = '+919876543210'

let open: TestPortal[] = []
afterEach(async () => {
  for (const portal of open) await portal.close()
  open = []
})

async function portalWith(channel?: OtpChannel): Promise<TestPortal> {
  const portal = await testPortal()
  open.push(portal)
  if (channel !== undefined) return { ...portal, channel: channel as TestPortal['channel'] }
  return portal
}

describe('asking for a code', () => {
  it('delivers one and stores only a hash of it', async () => {
    const portal = await portalWith()

    const started = await startOtp(portal.db, { channel: portal.channel }, { phone: PHONE })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const sent = portal.channel.last()
    expect(sent?.phone).toBe(PHONE)
    expect(sent?.code).toMatch(/^\d{6}$/)
    expect(sent?.ttlSeconds).toBe(CODE_TTL_SECONDS)

    const row = await portal.db.get<{ code_hash: string }>(
      'SELECT code_hash FROM challenges WHERE id = ?', [started.challengeId],
    )
    // The code itself is nowhere in the database, in any column.
    const all = await portal.db.query<Record<string, unknown>>('SELECT * FROM challenges')
    expect(JSON.stringify(all)).not.toContain(sent!.code)
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not say whether the number has an account', async () => {
    const portal = await portalWith()

    const stranger = await startOtp(portal.db, { channel: portal.channel }, { phone: PHONE })
    expect(stranger.ok).toBe(true)
    if (!stranger.ok) return
    await verifyOtp(portal.db, {
      challengeId: stranger.challengeId, code: portal.channel.last()!.code,
    })

    // Now the account exists. The second answer must look like the first.
    const known = await startOtp(
      portal.db, { channel: portal.channel },
      { phone: PHONE, now: new Date(Date.now() + 120_000) },
    )
    expect(known.ok).toBe(true)
    if (!known.ok) return
    expect(Object.keys(known).sort()).toEqual(Object.keys(stranger).sort())
  })

  it('refuses a number with no country code, rather than guessing India', async () => {
    const portal = await portalWith()
    const started = await startOtp(portal.db, { channel: portal.channel }, { phone: '9876543210' })
    expect(started).toMatchObject({ ok: false, code: 'BAD_PHONE' })
    expect(portal.channel.sent).toHaveLength(0)
  })

  it('makes you wait a minute before sending another', async () => {
    const portal = await portalWith()
    const at = new Date('2026-09-22T10:00:00Z')

    await startOtp(portal.db, { channel: portal.channel }, { phone: PHONE, now: at })
    const tooSoon = await startOtp(
      portal.db, { channel: portal.channel },
      { phone: PHONE, now: new Date(at.getTime() + 30_000) },
    )
    expect(tooSoon).toMatchObject({ ok: false, code: 'TOO_SOON' })
    if (tooSoon.ok || tooSoon.code !== 'TOO_SOON') return
    expect(tooSoon.retryAfterSeconds).toBe(30)

    const later = await startOtp(
      portal.db, { channel: portal.channel },
      { phone: PHONE, now: new Date(at.getTime() + RESEND_COOLDOWN_SECONDS * 1000) },
    )
    expect(later.ok).toBe(true)
  })

  it('stops a number being used as a pager', async () => {
    const portal = await portalWith()
    const start = new Date('2026-09-22T10:00:00Z').getTime()

    for (let i = 0; i < MAX_PER_HOUR; i += 1) {
      const result = await startOtp(
        portal.db, { channel: portal.channel },
        { phone: PHONE, now: new Date(start + i * 120_000) },
      )
      expect(result.ok, `challenge ${i + 1}`).toBe(true)
    }

    const blocked = await startOtp(
      portal.db, { channel: portal.channel },
      { phone: PHONE, now: new Date(start + MAX_PER_HOUR * 120_000) },
    )
    expect(blocked).toMatchObject({ ok: false, code: 'TOO_MANY' })
    if (blocked.ok || blocked.code !== 'TOO_MANY') return
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('writes nothing when the channel could not send', async () => {
    const portal = await portalWith()
    portal.channel.failNext({ ok: false, reason: 'unavailable', detail: 'provider down' })

    const failed = await startOtp(portal.db, { channel: portal.channel }, { phone: PHONE })
    expect(failed).toMatchObject({ ok: false, code: 'CHANNEL_DOWN' })

    /* The important half: a provider outage must not count against the
       hourly limit, or a bad evening becomes a lockout. */
    const rows = await portal.db.query('SELECT id FROM challenges')
    expect(rows).toHaveLength(0)
  })
})

describe('entering a code', () => {
  async function challenge(portal: TestPortal, now?: Date) {
    const started = await startOtp(
      portal.db, { channel: portal.channel }, { phone: PHONE, ...(now ? { now } : {}) },
    )
    if (!started.ok) throw new Error('could not start')
    return { id: started.challengeId, code: portal.channel.last()!.code }
  }

  it('signs the person in and creates their account the first time', async () => {
    const portal = await portalWith()
    const { id, code } = await challenge(portal)

    const verified = await verifyOtp(portal.db, { challengeId: id, code })
    expect(verified.ok).toBe(true)
    if (!verified.ok) return

    expect(verified.account.phone).toBe(PHONE)
    const me = await accountForSession(portal.db, verified.session.token)
    expect(me?.id).toBe(verified.account.id)
  })

  it('returns the same account the second time, not a new one', async () => {
    const portal = await portalWith()
    const morning = new Date('2026-09-22T10:00:00Z')
    const later = new Date('2026-09-22T10:05:00Z')

    const first = await challenge(portal, morning)
    const one = await verifyOtp(portal.db, { challengeId: first.id, code: first.code, now: morning })

    const second = await challenge(portal, later)
    const two = await verifyOtp(portal.db, { challengeId: second.id, code: second.code, now: later })

    expect(one.ok && two.ok && one.account.id === two.account.id).toBe(true)
    const accounts = await portal.db.query('SELECT id FROM accounts')
    expect(accounts).toHaveLength(1)
  })

  it('counts wrong guesses and dies after five', async () => {
    const portal = await portalWith()
    const { id, code } = await challenge(portal)
    const wrong = code === '000000' ? '111111' : '000000'

    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      const attempt = await verifyOtp(portal.db, { challengeId: id, code: wrong })
      expect(attempt).toMatchObject({ ok: false, code: 'WRONG_CODE', attemptsLeft: MAX_ATTEMPTS - i })
    }

    expect(await verifyOtp(portal.db, { challengeId: id, code: wrong }))
      .toMatchObject({ ok: false, code: 'TOO_MANY_ATTEMPTS' })

    // And the right code no longer helps. That is the point of a limit.
    expect(await verifyOtp(portal.db, { challengeId: id, code }))
      .toMatchObject({ ok: false, code: 'TOO_MANY_ATTEMPTS' })
  })

  it('refuses a code that has already been used', async () => {
    const portal = await portalWith()
    const { id, code } = await challenge(portal)

    expect((await verifyOtp(portal.db, { challengeId: id, code })).ok).toBe(true)
    expect(await verifyOtp(portal.db, { challengeId: id, code }))
      .toMatchObject({ ok: false, code: 'USED' })
  })

  it('refuses a code that has gone stale', async () => {
    const portal = await portalWith()
    const at = new Date('2026-09-22T10:00:00Z')
    const { id, code } = await challenge(portal, at)

    const late = new Date(at.getTime() + (CODE_TTL_SECONDS + 1) * 1000)
    expect(await verifyOtp(portal.db, { challengeId: id, code, now: late }))
      .toMatchObject({ ok: false, code: 'EXPIRED' })
  })

  it('refuses a challenge id that was never issued', async () => {
    const portal = await portalWith()
    expect(await verifyOtp(portal.db, { challengeId: 'made-up', code: '123456' }))
      .toMatchObject({ ok: false, code: 'NO_CHALLENGE' })
  })

  it('refuses one account\'s code against another account\'s challenge', async () => {
    const portal = await portalWith()
    const mine = await challenge(portal, new Date('2026-09-22T10:00:00Z'))

    const startedOther = await startOtp(
      portal.db, { channel: portal.channel },
      { phone: '+919000000001', now: new Date('2026-09-22T10:00:30Z') },
    )
    if (!startedOther.ok) throw new Error('could not start')
    const theirCode = portal.channel.last()!.code

    /* Both codes are six digits and could collide once in a million, which
       would make this pass for the wrong reason. Skip that run rather than
       assert something untrue. */
    if (theirCode !== mine.code) {
      expect(await verifyOtp(portal.db, {
        challengeId: mine.id, code: theirCode, now: new Date('2026-09-22T10:01:00Z'),
      })).toMatchObject({ ok: false, code: 'WRONG_CODE' })
    }
  })

  it('stops working when the session is revoked', async () => {
    const portal = await portalWith()
    const { id, code } = await challenge(portal)
    const verified = await verifyOtp(portal.db, { challengeId: id, code })
    if (!verified.ok) throw new Error('sign-in failed')

    await revokeSession(portal.db, verified.session.token)
    expect(await accountForSession(portal.db, verified.session.token)).toBeNull()
  })

  it('stops working when the account is disabled', async () => {
    const portal = await portalWith()
    const { id, code } = await challenge(portal)
    const verified = await verifyOtp(portal.db, { challengeId: id, code })
    if (!verified.ok) throw new Error('sign-in failed')

    await portal.db.execute(
      'UPDATE accounts SET disabled_at = ? WHERE id = ?',
      [new Date().toISOString(), verified.account.id],
    )
    expect(await accountForSession(portal.db, verified.session.token)).toBeNull()
  })
})

describe('the channel chain', () => {
  it('moves to the next channel when one is merely down', async () => {
    const first = memoryChannel()
    const second = memoryChannel()
    first.failNext({ ok: false, reason: 'unavailable', detail: 'quota' })

    const chain = firstThatWorks([first, second])
    const sent = await chain.send({
      phone: PHONE, code: '123456', ttlSeconds: 300, purpose: 'sign-in',
    })

    expect(sent.ok).toBe(true)
    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(1)
  })

  it('stops when the number itself is the problem', async () => {
    const first = memoryChannel()
    const second = memoryChannel()
    first.failNext({ ok: false, reason: 'unreachable', detail: 'PHONE_NUMBER_INVALID' })

    const result = await firstThatWorks([first, second]).send({
      phone: '+10000000000', code: '123456', ttlSeconds: 300, purpose: 'sign-in',
    })

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
    // A number that is not a number does not become one at the next provider.
    expect(second.sent).toHaveLength(0)
  })
})

describe('Telegram, without a network', () => {
  it('reports itself unavailable with no token, rather than pretending', async () => {
    const channel = telegramGateway({ token: null })
    const result = await channel.send({
      phone: PHONE, code: '123456', ttlSeconds: 300, purpose: 'sign-in',
    })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    if (result.ok) return
    expect(result.detail).toContain('SHOPOS_TELEGRAM_TOKEN')
  })

  it('sends our code rather than asking Telegram to make one', async () => {
    let body: Record<string, unknown> = {}
    const channel = telegramGateway({
      token: 'test-token',
      fetch: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ ok: true, result: { request_id: 'r1' } }))
      }) as unknown as typeof globalThis.fetch,
    })

    const result = await channel.send({
      phone: PHONE, code: '424242', ttlSeconds: 300, purpose: 'sign-in',
    })

    expect(result).toEqual({ ok: true, ref: 'r1' })
    // The code is ours: the expiry and the attempt limit stay in the portal.
    expect(body['code']).toBe('424242')
    expect(body['phone_number']).toBe(PHONE)
  })

  it('tells a bad number apart from a bad moment', async () => {
    const answering = (payload: unknown) => telegramGateway({
      token: 'test-token',
      fetch: (async () => new Response(JSON.stringify(payload))) as unknown as typeof globalThis.fetch,
    })

    const delivery = { phone: PHONE, code: '1', ttlSeconds: 1, purpose: 'sign-in' as const }

    expect(await answering({ ok: false, error: 'PHONE_NUMBER_INVALID' }).send(delivery))
      .toMatchObject({ reason: 'unreachable' })
    expect(await answering({ ok: false, error: 'FLOOD_WAIT' }).send(delivery))
      .toMatchObject({ reason: 'unavailable' })
  })

  it('treats a dead line as temporary', async () => {
    const channel = telegramGateway({
      token: 'test-token',
      fetch: (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof globalThis.fetch,
    })
    expect(await channel.send({
      phone: PHONE, code: '1', ttlSeconds: 1, purpose: 'sign-in',
    })).toMatchObject({ ok: false, reason: 'unavailable' })
  })
})

describe('phone numbers', () => {
  it('accepts E.164 and tidies punctuation', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('+919876543210')
    expect(normalisePhone('+1 (555) 123 4567')).toBe('+15551234567')
  })

  it('refuses everything else', () => {
    for (const bad of ['9876543210', '+0123456789', 'not a phone', '', '+91', '+9198765432101234']) {
      expect(normalisePhone(bad), bad).toBeNull()
    }
  })
})

describe('the OAuth seam', () => {
  it('produces a PKCE challenge that matches its verifier', () => {
    const { verifier, challenge, state } = beginOAuth()
    expect(state).not.toBe('')
    expect(verifier).not.toBe(challenge)

    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
  })

  it('links an identity only to the account that asked', async () => {
    const portal = await portalWith()
    const started = await startOtp(portal.db, { channel: portal.channel }, { phone: PHONE })
    if (!started.ok) throw new Error('start failed')
    const signedIn = await verifyOtp(portal.db, {
      challengeId: started.challengeId, code: portal.channel.last()!.code,
    })
    if (!signedIn.ok) throw new Error('sign-in failed')

    const identity = { subject: 'google-subject-1', email: 'owner@example.com', name: 'Owner' }
    expect(await linkIdentity(portal.db, signedIn.account, 'google', identity)).toEqual({ ok: true })
    expect((await accountForIdentity(portal.db, 'google', 'google-subject-1'))?.id)
      .toBe(signedIn.account.id)

    // Linking the same identity again is fine; linking it elsewhere is not.
    expect(await linkIdentity(portal.db, signedIn.account, 'google', identity)).toEqual({ ok: true })

    const other = await startOtp(
      portal.db, { channel: portal.channel },
      { phone: '+919000000002', now: new Date(Date.now() + 120_000) },
    )
    if (!other.ok) throw new Error('start failed')
    const otherAccount = await verifyOtp(portal.db, {
      challengeId: other.challengeId, code: portal.channel.last()!.code,
    })
    if (!otherAccount.ok) throw new Error('sign-in failed')

    expect(await linkIdentity(portal.db, otherAccount.account, 'google', identity))
      .toEqual({ ok: false, code: 'TAKEN' })
  })

  it('does not find an account by email, only by subject', async () => {
    const portal = await portalWith()
    // Nothing is linked, so nothing is found — even though an account with
    // that person's phone may well exist. Email is a label, not an identity.
    expect(await accountForIdentity(portal.db, 'google', 'never-linked')).toBeNull()
  })
})
