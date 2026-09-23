import { webcrypto } from 'node:crypto'
import { setSetting, getSetting, type SqlDriver } from '@shopos/core'
import { encodePayload, toBase64Url, type SigningKey } from '@shopos/core/licence'

/**
 * A bench till that is allowed to have other tills.
 *
 * `multiTill` gates `letThemIn`, so a bench shop with no licence refuses every
 * pairing and the convergence runs never start. That is the gate working. What
 * it means here is that a bench till has to carry a licence, the same way a
 * real shop running four counters does.
 *
 * The key is minted in this process and is not the one the product ships. The
 * shipped public key's private half is not in this repository and must never
 * be, so no test and no bench can sign a token the real build would accept —
 * which is the property that makes licensing worth anything. `handleSyncRequest`
 * takes the keys to check against for exactly this reason.
 *
 * Deliberately a copy of the same twenty lines in `packages/core/test`, rather
 * than an import across a package boundary into somebody else's test folder.
 * Two independent processes, two independent keys, and neither package reaches
 * into the other to get set up.
 */

const pair = await webcrypto.subtle.generateKey(
  { name: 'Ed25519' }, true, ['sign', 'verify'],
) as webcrypto.CryptoKeyPair

/** Passed to `handleSyncRequest` in place of the build's own list. */
export const BENCH_KEYS: readonly SigningKey[] = [{
  kid: 'bench-key',
  publicKey: toBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))),
}]

/**
 * Puts a perpetual `branches` licence on a bench shop.
 *
 * The top tier because the bench exists to exercise the protocol, and a run
 * that failed because the fixture was on the wrong plan would be a bench
 * testing its own scaffolding. Perpetual for the same reason: a `paidThrough`
 * would make a suite start failing on a date.
 */
export async function licenseBenchShop(db: SqlDriver): Promise<void> {
  const shopId = await getSetting(db, 'shop_id')
  if (shopId === null) throw new Error('licenseBenchShop: no shop_id — seed the shop first')

  const payload = encodePayload({
    shopId, tier: 'branches', paidThrough: null, tills: 99,
    issuedAt: new Date().toISOString(), kid: 'bench-key',
  })
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(payload),
  ))
  await setSetting(db, 'licence_token', `${payload}.${toBase64Url(signature)}`, new Date().toISOString())
}
