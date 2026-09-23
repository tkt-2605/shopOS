import type { SigningKey } from '../domain/licence.js'

/**
 * The deployment's own values. **This is the file you edit when you have real
 * ones**, and it is the only file you edit.
 *
 * `LICENCE_KEYS` is real. The other two are still placeholders, and that is
 * deliberate and checked: `licencePlaceholders.test.ts` pins the shape of
 * whatever this file is in, because the failure mode of a half-configured
 * licensing system is that it silently trusts nothing *and says everything is
 * fine*.
 *
 * That test has already earned its keep once. A minisign key — the updater's,
 * from `npx tauri signer generate` — was pasted into `LICENCE_KEYS`, and the
 * result was worse than leaving it empty: `licensingConfigured()` answered
 * true while every genuine licence was refused as `NOT_CONFIGURED`, which is
 * the code that means *this build has no keys at all*. Right shape, wrong
 * keypair, and the only thing that said so was the byte count. The two are
 * separate keys from separate commands and neither can stand in for the other.
 *
 * ## What each one is and where it comes from
 *
 * | Value | Where it comes from | Blocks |
 * |---|---|---|
 * | `LICENCE_KEYS` | `cli.ts keygen` — the public half | verifying any licence |
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
 * Raw Ed25519, **exactly 32 bytes**, base64url — which is 43 characters with
 * no padding. The length is the only thing that distinguishes this from the
 * updater's minisign key, which is 114 bytes and belongs in `tauri.conf.json`;
 * see the note at the top of the file for what happens when they are swapped.
 *
 * Empty was the honest placeholder before there was a key, and is still the
 * right thing to leave behind if this one is ever retired without a
 * replacement. A fake 32 bytes would be worse than either: every licence would
 * fail with `BAD_SIGNATURE`, which reads like a forgery and sends somebody
 * looking for an attacker instead of for this file.
 *
 *     npx tsx apps/portal/src/cli.ts keygen --kid shopos-2027
 *     # publicKey goes here; privateKey goes in SHOPOS_LICENCE_KEY
 */
export const LICENCE_KEYS: readonly SigningKey[] = [
  { kid: 'shopos-2026', publicKey: 'iKAW5Za2hLbQawgMxO-rqhahFktrXvbc3wRmIzI6kYc' },
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
