import { webcrypto } from 'node:crypto'
import type { SqlDriver } from '../src/db/driver.js'
import { setSetting, getSetting } from '../src/services/bootstrap.js'
import { encodePayload, toBase64Url, type SigningKey, type Tier } from '../src/domain/licence.js'

/**
 * A signing key a test is allowed to have.
 *
 * `config/licensing.ts` ships one real public key and its private half is not
 * in this repository and must never be. So a test cannot mint a token the
 * build would accept — which is exactly the property that makes the licensing
 * worth anything, and exactly what makes pairing untestable without a seam.
 *
 * The seam is `SyncServerOptions.keys`, and this is what tests pass through
 * it. The keypair is generated once per process: real Ed25519, real
 * signatures, verified by the same `verifyToken` the shipped app runs. Nothing
 * here weakens the check; it only points it at a different key.
 */

const pair = await webcrypto.subtle.generateKey(
  { name: 'Ed25519' }, true, ['sign', 'verify'],
) as webcrypto.CryptoKeyPair

/** Hand these to anything that would otherwise read the build's own list. */
export const TEST_KEYS: readonly SigningKey[] = [{
  kid: 'test-key',
  publicKey: toBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))),
}]

/** A signed licence for a shop, as the portal would have issued it. */
export async function signLicence(
  shopId: string,
  tier: Tier = 'multi',
  paidThrough: string | null = null,
): Promise<string> {
  const payload = encodePayload({
    shopId, tier, paidThrough, tills: 9,
    issuedAt: new Date().toISOString(), kid: 'test-key',
  })
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(payload),
  ))
  return `${payload}.${toBase64Url(signature)}`
}

/**
 * Puts a licence on a till, the way `installToken` would.
 *
 * Written straight into `settings` rather than through `installToken`, because
 * that function verifies against the *build's* keys and would refuse this one.
 * The verification that matters happens on the way back out, in `entitled`,
 * which is handed `TEST_KEYS`.
 *
 * Defaults to `multi` because the thing almost every caller wants is a shop
 * that is allowed to add a second till.
 */
export async function licenseTill(
  db: SqlDriver, tier: Tier = 'multi', paidThrough: string | null = null,
): Promise<void> {
  const shopId = await getSetting(db, 'shop_id')
  if (shopId === null) throw new Error('licenseTill: this db has no shop_id — bootstrap it first')
  await setSetting(db, 'licence_token', await signLicence(shopId, tier, paidThrough), new Date().toISOString())
}
