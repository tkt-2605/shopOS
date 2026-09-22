import { createHash, randomBytes } from 'node:crypto'
import type { SqlDriver } from '@shopos/core'
import type { Account } from '../store.js'

/**
 * Signing in with somebody else's account. **A seam, not an integration.**
 *
 * Nothing here talks to Google or to anyone. What it does is fix the shape of
 * the thing, so that adding a provider is writing one object rather than
 * deciding again where identities live, what a callback is allowed to trust,
 * and how an OAuth login and a phone login end up being the same person.
 *
 * ## The three decisions already made
 *
 * **Identities are separate rows.** `identities(provider, subject)` points at
 * an account; it is not a column on `accounts`. One owner can sign in with a
 * phone on Monday and with Google on Tuesday and be one account, and neither
 * is the real one.
 *
 * **An email is not an identity.** Linking by email address means anybody who
 * can get a provider to assert an email can take over an account, and
 * providers have been talked into that more than once. The subject is the
 * identity; the email is a label to show. So an OAuth login whose email
 * matches an existing account does **not** merge into it -- linking is
 * something the signed-in owner does on purpose, through `linkIdentity`.
 *
 * **PKCE always**, even for a confidential client. The portal is small enough
 * that its redirect handling will get less attention than it deserves, and
 * PKCE is the thing that makes a leaked authorisation code useless.
 *
 * ## Dropping one in
 *
 * Write an `OAuthProvider`, register it in the portal's config, and the routes
 * and the store below need no changes.
 */

export interface OAuthIdentity {
  /** The provider's stable id for this person. Never an email. */
  subject: string
  email: string | null
  name: string | null
}

export interface OAuthProvider {
  readonly name: string
  /** Where to send the browser. `state` and `challenge` come from `beginOAuth`. */
  authorizeUrl(input: { state: string; challenge: string; redirectUri: string }): string
  /** Turns a callback's code into an identity. Throws if the provider refuses. */
  exchange(input: { code: string; verifier: string; redirectUri: string }): Promise<OAuthIdentity>
}

/**
 * The one you will probably write first.
 *
 * **Drop in here.** Needs a client id and secret from a Google Cloud project
 * with the consent screen published, and `redirectUri` registered there
 * exactly as the portal sends it. Endpoints:
 * `https://accounts.google.com/o/oauth2/v2/auth` and
 * `https://oauth2.googleapis.com/token`; verify the `id_token` against
 * Google's JWKS rather than trusting the `userinfo` response, and take
 * `sub` as the subject.
 */
export function googleOAuth(config: { clientId: string | null; clientSecret: string | null }): OAuthProvider {
  const unconfigured = config.clientId === null || config.clientSecret === null

  return {
    name: 'google',
    authorizeUrl() {
      if (unconfigured) throw new Error('Google OAuth is not configured — see googleOAuth() in auth/oauth.ts')
      throw new Error('googleOAuth is a placeholder: authorizeUrl is not written yet')
    },
    async exchange() {
      throw new Error('googleOAuth is a placeholder: exchange is not written yet')
    },
  }
}

export interface PendingOAuth {
  state: string
  verifier: string
  challenge: string
}

/**
 * Starts a flow: a random `state` against CSRF, and a PKCE verifier.
 *
 * The verifier is returned rather than stored, because where it is kept is
 * the caller's problem -- a cookie for a browser flow, a row for a device
 * flow -- and this function should not decide that for every future
 * provider.
 */
export function beginOAuth(): PendingOAuth {
  const verifier = randomBytes(32).toString('base64url')
  return {
    state: randomBytes(16).toString('base64url'),
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

/**
 * Attaches a provider identity to an account that is already signed in.
 *
 * The only way an identity ever reaches an account. There is no path where a
 * callback creates the link by itself, which is what stops a provider's email
 * assertion from being an account takeover.
 */
export async function linkIdentity(
  db: SqlDriver,
  account: Account,
  provider: string,
  identity: OAuthIdentity,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; code: 'TAKEN' }> {
  const existing = await db.get<{ account_id: string }>(
    'SELECT account_id FROM identities WHERE provider = ? AND subject = ?',
    [provider, identity.subject],
  )
  if (existing !== undefined) {
    return existing.account_id === account.id ? { ok: true } : { ok: false, code: 'TAKEN' }
  }

  await db.execute(
    `INSERT INTO identities (id, account_id, provider, subject, email, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      randomBytes(16).toString('hex'), account.id, provider,
      identity.subject, identity.email, now.toISOString(),
    ],
  )
  return { ok: true }
}

/**
 * The account an identity already belongs to, or null.
 *
 * Null means "not linked", and the caller's correct response is to ask the
 * person to sign in with their phone first and then link -- never to create
 * an account, and never to guess from the email.
 */
export async function accountForIdentity(
  db: SqlDriver, provider: string, subject: string,
): Promise<Account | null> {
  const row = await db.get<{
    id: string; phone: string; name: string | null
    created_at: string; disabled_at: string | null
  }>(
    `SELECT a.id, a.phone, a.name, a.created_at, a.disabled_at
       FROM identities i JOIN accounts a ON a.id = i.account_id
      WHERE i.provider = ? AND i.subject = ?`,
    [provider, subject],
  )
  if (row === undefined) return null
  return {
    id: row.id, phone: row.phone, name: row.name,
    createdAt: row.created_at, disabledAt: row.disabled_at,
  }
}
