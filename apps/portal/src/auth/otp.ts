import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { SqlDriver } from '@shopos/core'
import type { OtpChannel, OtpPurpose } from '../otp/channel.js'
import type { Account } from '../store.js'

/**
 * Signing in with a phone number and six digits.
 *
 * The rules live here rather than in a provider, because every one of them is
 * a decision somebody has to be able to find and argue with:
 *
 * | Rule | Value | Why |
 * |---|---|---|
 * | Code length | 6 digits | what people expect to be asked for |
 * | Lifetime | 5 minutes | long enough for a slow SMS, short enough to matter |
 * | Attempts | 5, then dead | a million codes, five guesses: 1 in 200,000 |
 * | Resend cooldown | 60 seconds | stops the button being a way to bill us |
 * | Per number, per hour | 5 challenges | stops a number being used as a pager |
 *
 * ## What is stored
 *
 * A hash of the code, never the code. The challenge id is 128 random bits and
 * goes into the hash, so it salts it: two people with the same six digits at
 * the same moment have different rows, and a stolen database is not a set of
 * working codes even for the five minutes it stays fresh.
 *
 * ## Enumeration
 *
 * `start` answers identically whether or not the number has an account, and
 * an account is created on the first successful verification rather than at
 * `start`. Otherwise the portal is a free service for checking which of your
 * competitors' phone numbers are ShopOS customers.
 *
 * ## The one thing this deliberately does not do
 *
 * It does not reach the till. Staff sign in at the counter with a username
 * and a password, offline, forever -- see `services/auth.ts`. An OTP needs a
 * network and the counter has to work without one, so a phone code can never
 * stand between a cashier and a customer. These accounts are the *owner's*,
 * for the portal: licences, billing, the cloud tier and the phone view.
 */

export const CODE_DIGITS = 6
export const CODE_TTL_SECONDS = 5 * 60
export const MAX_ATTEMPTS = 5
export const RESEND_COOLDOWN_SECONDS = 60
export const MAX_PER_HOUR = 5
export const SESSION_DAYS = 30

export interface StartInput {
  phone: string
  purpose?: OtpPurpose
  now?: Date
}

export type StartResult =
  | {
      ok: true
      challengeId: string
      /** When the code stops being accepted. Shown so the screen can count down. */
      expiresAt: string
      channel: string
      /**
       * Set only when a development channel was used, so the response can
       * carry the code on a developer's machine and never in production.
       * Production channels return null and the field is useless.
       */
      devCode: string | null
    }
  | { ok: false; code: 'BAD_PHONE'; detail: string }
  | { ok: false; code: 'TOO_SOON'; retryAfterSeconds: number }
  | { ok: false; code: 'TOO_MANY'; retryAfterSeconds: number }
  | { ok: false; code: 'UNREACHABLE'; detail: string }
  | { ok: false; code: 'CHANNEL_DOWN'; detail: string }

export interface OtpOptions {
  channel: OtpChannel
  /** True only in development: lets `start` hand the code back in the response. */
  exposeCodes?: boolean
}

/**
 * Asks for a code.
 *
 * Every refusal names a number the caller can put in a sentence, because
 * "try again later" with no later is the worst thing a login screen can say.
 */
export async function startOtp(
  db: SqlDriver, opts: OtpOptions, input: StartInput,
): Promise<StartResult> {
  const now = input.now ?? new Date()
  const phone = normalisePhone(input.phone)
  if (phone === null) {
    return { ok: false, code: 'BAD_PHONE', detail: 'a phone number with a country code, like +919876543210' }
  }

  const purpose: OtpPurpose = input.purpose ?? 'sign-in'

  const recent = await db.query<{ created_at: string }>(
    `SELECT created_at FROM challenges
      WHERE phone = ? AND created_at > ?
      ORDER BY created_at DESC`,
    [phone, new Date(now.getTime() - 60 * 60 * 1000).toISOString()],
  )

  const newest = recent[0]
  if (newest !== undefined) {
    const since = (now.getTime() - Date.parse(newest.created_at)) / 1000
    if (since < RESEND_COOLDOWN_SECONDS) {
      return {
        ok: false, code: 'TOO_SOON',
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - since),
      }
    }
  }

  if (recent.length >= MAX_PER_HOUR) {
    const oldest = recent[recent.length - 1] as { created_at: string }
    const freesAt = Date.parse(oldest.created_at) + 60 * 60 * 1000
    return {
      ok: false, code: 'TOO_MANY',
      retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)),
    }
  }

  const challengeId = randomBytes(16).toString('hex')
  const code = randomCode()
  const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString()

  const sent = await opts.channel.send({
    phone, code, ttlSeconds: CODE_TTL_SECONDS, purpose,
  })

  if (!sent.ok) {
    /* Nothing is written when nothing was sent. A row here would count
       against the hourly limit for a code the person never received, which
       turns a provider outage into a lockout. */
    return sent.reason === 'unreachable'
      ? { ok: false, code: 'UNREACHABLE', detail: sent.detail }
      : { ok: false, code: 'CHANNEL_DOWN', detail: sent.detail }
  }

  await db.execute(
    `INSERT INTO challenges (id, phone, code_hash, purpose, channel, ref, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      challengeId, phone, hashCode(challengeId, code), purpose,
      opts.channel.name, sent.ref, now.toISOString(), expiresAt,
    ],
  )

  return {
    ok: true,
    challengeId,
    expiresAt,
    channel: opts.channel.name,
    devCode: opts.exposeCodes === true ? code : null,
  }
}

export interface VerifyInput {
  challengeId: string
  code: string
  now?: Date
  /** For the session row, so a support call can see where a login came from. */
  issuedBy?: string
}

export type VerifyOtpResult =
  | { ok: true; account: Account; session: { token: string; expiresAt: string } }
  | { ok: false; code: 'NO_CHALLENGE' }
  | { ok: false; code: 'EXPIRED' }
  | { ok: false; code: 'USED' }
  | { ok: false; code: 'WRONG_CODE'; attemptsLeft: number }
  | { ok: false; code: 'TOO_MANY_ATTEMPTS' }
  | { ok: false; code: 'ACCOUNT_DISABLED' }

interface ChallengeRow {
  id: string
  phone: string
  code_hash: string
  expires_at: string
  attempts: number
  consumed_at: string | null
}

/**
 * Checks a code and, if it is right, signs the person in.
 *
 * One transaction: the attempt count, the consumption and the session are one
 * fact. Two concurrent requests with the same right code must produce one
 * session, not two, and must not each read `attempts` as four.
 */
export async function verifyOtp(
  db: SqlDriver, input: VerifyInput,
): Promise<VerifyOtpResult> {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()

  return db.transaction(async (tx) => {
    const challenge = await tx.get<ChallengeRow>(
      `SELECT id, phone, code_hash, expires_at, attempts, consumed_at
         FROM challenges WHERE id = ?`,
      [input.challengeId],
    )

    if (challenge === undefined) return { ok: false as const, code: 'NO_CHALLENGE' as const }
    if (challenge.consumed_at !== null) return { ok: false as const, code: 'USED' as const }
    if (nowIso > challenge.expires_at) return { ok: false as const, code: 'EXPIRED' as const }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      return { ok: false as const, code: 'TOO_MANY_ATTEMPTS' as const }
    }

    const right = sameCode(challenge.code_hash, hashCode(challenge.id, input.code.trim()))

    if (!right) {
      const attempts = challenge.attempts + 1
      await tx.execute('UPDATE challenges SET attempts = ? WHERE id = ?', [attempts, challenge.id])
      return attempts >= MAX_ATTEMPTS
        ? { ok: false as const, code: 'TOO_MANY_ATTEMPTS' as const }
        : { ok: false as const, code: 'WRONG_CODE' as const, attemptsLeft: MAX_ATTEMPTS - attempts }
    }

    /* Consumed before the session is made, so that a failure after this point
       cannot leave a code that still works. */
    await tx.execute(
      'UPDATE challenges SET consumed_at = ?, attempts = ? WHERE id = ?',
      [nowIso, challenge.attempts + 1, challenge.id],
    )

    const account = await findOrCreateAccount(tx, challenge.phone, now)
    if (account.disabledAt !== null) {
      return { ok: false as const, code: 'ACCOUNT_DISABLED' as const }
    }

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString()
    await tx.execute(
      `INSERT INTO sessions (token_hash, account_id, created_at, expires_at, issued_by)
       VALUES (?, ?, ?, ?, ?)`,
      [hashToken(token), account.id, nowIso, expiresAt, input.issuedBy ?? 'otp'],
    )

    return { ok: true as const, account, session: { token, expiresAt } }
  })
}

/** The account behind a session token, or null for anything that is not one. */
export async function accountForSession(
  db: SqlDriver, token: string, now: Date = new Date(),
): Promise<Account | null> {
  const row = await db.get<{
    id: string; phone: string; name: string | null
    created_at: string; disabled_at: string | null
  }>(
    `SELECT a.id, a.phone, a.name, a.created_at, a.disabled_at
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    [hashToken(token), now.toISOString()],
  )
  if (row === undefined || row.disabled_at !== null) return null
  return {
    id: row.id, phone: row.phone, name: row.name,
    createdAt: row.created_at, disabledAt: row.disabled_at,
  }
}

export async function revokeSession(db: SqlDriver, token: string, now = new Date()): Promise<void> {
  await db.execute(
    'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    [now.toISOString(), hashToken(token)],
  )
}

async function findOrCreateAccount(
  tx: SqlDriver, phone: string, now: Date,
): Promise<Account> {
  const existing = await tx.get<{
    id: string; phone: string; name: string | null
    created_at: string; disabled_at: string | null
  }>('SELECT id, phone, name, created_at, disabled_at FROM accounts WHERE phone = ?', [phone])

  if (existing !== undefined) {
    return {
      id: existing.id, phone: existing.phone, name: existing.name,
      createdAt: existing.created_at, disabledAt: existing.disabled_at,
    }
  }

  const id = randomBytes(16).toString('hex')
  const createdAt = now.toISOString()
  await tx.execute(
    'INSERT INTO accounts (id, phone, name, created_at) VALUES (?, ?, NULL, ?)',
    [id, phone, createdAt],
  )
  return { id, phone, name: null, createdAt, disabledAt: null }
}

/* ── the pieces ────────────────────────────────────────────────────────── */

/**
 * Six digits, uniformly.
 *
 * `randomInt` with a range rather than `randomBytes` and a modulo, because
 * `bytes % 1000000` is very slightly biased towards low numbers and there is
 * no reason to accept even a small bias in the one number that is the whole
 * security of this.
 */
function randomCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')
}

function hashCode(challengeId: string, code: string): string {
  return createHash('sha256').update(`${challengeId}:${code}`).digest('hex')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant time, so the comparison cannot be used to learn the hash. */
function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * E.164, or null.
 *
 * Deliberately narrow. A ten-digit Indian number typed without a country code
 * is the common case and is *not* silently given `+91`: this portal will have
 * shops outside India before it has a way to change a phone number, and
 * guessing the country from the developer's own is how an account ends up
 * belonging to somebody in another country with the same ten digits.
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.replace(/[\s()\-.]/g, '')
  return /^\+[1-9]\d{7,14}$/.test(trimmed) ? trimmed : null
}
