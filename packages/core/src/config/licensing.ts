import type { SigningKey } from '../domain/licence.js'

/**
 * The deployment's own values. **This is the file you edit when you have real
 * ones**, and it is the only file you edit.
 *
 * Everything in it is a placeholder today. That is deliberate and it is
 * checked: `licence.test.ts` asserts that a build carrying placeholders
 * refuses every token rather than accepting some convenient default, because
 * the failure mode of a half-configured licensing system is that it silently
 * trusts nothing *and says everything is fine*.
 *
 * ## What each one is and where it comes from
 *
 * | Value | Where it comes from | Blocks |
 * |---|---|---|
 * | `LICENCE_KEYS` | `npm run portal -- keygen` — the public half | verifying any licence |
 * | `PORTAL_BASE_URL` | the VPS and domain, Phase 6 | fetching a renewal |
 * | `UPDATE_FEED_URL` | the GitHub owner/repo, decision 3 in progress.md | the updater |
 *
 * The private half of the signing key never appears in this repository, in
 * this file or in any build. It lives in the portal's environment and in the
 * owner's backup of it, and nowhere else. A build that could sign a licence
 * is a build that can mint itself one.
 *
 * ## Rotation
 *
 * `LICENCE_KEYS` is a list, not a key, so a new key can be shipped before the
 * old one stops being used. The order is meaningless -- a token names its own
 * `kid` -- so adding a key is appending to the array, and retiring one is
 * removing it after the last licence issued under it has expired.
 */

/**
 * The public keys this build will accept a licence from.
 *
 * Empty is the honest placeholder. A fake 32 bytes here would be worse: every
 * licence would fail with `BAD_SIGNATURE`, which reads like a forgery and
 * would send somebody looking for an attacker instead of for this file.
 * Empty produces `NOT_CONFIGURED`, which names the actual problem.
 *
 * To drop in the real one:
 *
 *     npm run portal -- keygen
 *     # prints { kid, publicKey, privateKey }
 *     # publicKey goes here; privateKey goes in the portal's environment
 */
export const LICENCE_KEYS: readonly SigningKey[] = [
  // { kid: 'shopos-2026', publicKey: '<32 bytes, base64url>' },
]

/**
 * Where a till asks for its current licence, and where "Renew" opens.
 *
 * Null until there is a domain. Every caller treats null as "there is no
 * portal", which is the same path as "the portal is unreachable" -- a shop on
 * a dead line -- and so is already the tested path rather than a new one.
 */
export const PORTAL_BASE_URL: string | null = null

/**
 * Where the updater looks for `latest.json`.
 *
 * Null until the GitHub owner/repo is decided. The updater treats null the
 * same way it treats an unreachable feed: it says the till is up to date as
 * far as it can tell, and it never blocks anything.
 */
export const UPDATE_FEED_URL: string | null = null

/** Whether this build has everything it needs to verify a licence. */
export function licensingConfigured(): boolean {
  return LICENCE_KEYS.length > 0
}
