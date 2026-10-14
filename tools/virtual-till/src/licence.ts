import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { setSetting, getSetting, type SqlDriver } from '@shopos/core'
import { encodePayload, toBase64Url, type SigningKey } from '@shopos/core/licence'

/**
 * A bench till that is allowed to have other tills.
 *
 * `multiTill` gates `letThemIn`, so a bench shop with no licence refuses every
 * pairing and the convergence runs never start; and it gates a counter taking
 * money, so a bench counter with no licence it can check is view-only. That is
 * the gate working. What it means here is that a bench till has to carry a
 * licence, the same way a real shop running four counters does.
 *
 * The key is the bench's own and is not the one the product ships. The shipped
 * public key's private half is not in this repository and must never be, so no
 * test and no bench can sign a token the real build would accept -- which is
 * the property that makes licensing worth anything. This one is the opposite:
 * a fixed seed, written down here, so that every bench till -- in one process
 * or, in the namespace soak, one per machine -- signs and checks with the same
 * key. Nothing the product ships trusts it.
 *
 * Deliberately separate from the same few lines in `packages/core/test`,
 * rather than an import across a package boundary into somebody else's test
 * folder.
 */

/** Thirty-two bytes, and nothing else about them is special. */
const BENCH_SEED = Buffer.from('shopos-bench-licence-key-not-for-shipping!'.slice(0, 32), 'utf8')

/** An Ed25519 private key in PKCS#8 is this prefix and the seed. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519, BENCH_SEED]), format: 'der', type: 'pkcs8',
})
const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' })

/** Passed to `handleSyncRequest`, and set as the process's own (`useLicenceKeys`). */
export const BENCH_KEYS: readonly SigningKey[] = [{ kid: 'bench-key', publicKey: String(publicJwk.x) }]

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
  const signature = new Uint8Array(sign(null, Buffer.from(payload, 'utf8'), privateKey))
  await setSetting(db, 'licence_token', `${payload}.${toBase64Url(signature)}`, new Date().toISOString())
}
