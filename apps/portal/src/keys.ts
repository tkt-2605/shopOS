import { webcrypto } from 'node:crypto'
import {
  encodePayload, toBase64Url, fromBase64Url, type LicenceToken,
} from '@shopos/core/licence'

/**
 * The private half. Lives here and nowhere near a till.
 *
 * A build that can sign a licence is a build that can mint itself one, so the
 * signing key never appears in `packages/core`, in `apps/pos`, or in any
 * artefact either of them produces. The only thing that crosses is the public
 * key, pasted into `config/licensing.ts` by hand.
 *
 * ## Where the key actually lives
 *
 * In `SHOPOS_LICENCE_KEY` in the portal's environment, and in the owner's
 * backup of it. Not in this repository, not in a `.env` that gets committed
 * by accident, and not in the portal's own database -- a database dump is a
 * thing that gets shared with a support engineer, and this must not be in
 * one.
 *
 * Losing it means every licence in the field stops verifying at the next key
 * rotation and no new ones can be issued. Back it up twice, in different
 * places, before issuing anything to a paying shop.
 */

export interface Keypair {
  kid: string
  /** Raw 32-byte Ed25519 public key, base64url. Goes in `config/licensing.ts`. */
  publicKey: string
  /** PKCS#8, base64url. Goes in `SHOPOS_LICENCE_KEY`. Never anywhere else. */
  privateKey: string
}

/**
 * A new signing keypair.
 *
 * The `kid` carries the year it was made, because the question a person asks
 * about a key is "is this the old one?" and a random string cannot answer it.
 */
export async function generateKeypair(kid?: string): Promise<Keypair> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'Ed25519' }, true, ['sign', 'verify'],
  ) as webcrypto.CryptoKeyPair

  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))
  const privateKey = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey))

  return {
    kid: kid ?? `shopos-${new Date().getFullYear()}`,
    publicKey: toBase64Url(publicKey),
    privateKey: toBase64Url(privateKey),
  }
}

/** The signing key, loaded once. Throws with the fix rather than a stack trace. */
export async function loadSigningKey(privateKey: string): Promise<webcrypto.CryptoKey> {
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(privateKey.trim())
  } catch {
    throw new Error('SHOPOS_LICENCE_KEY is not base64url — see `portal keygen`')
  }
  return webcrypto.subtle.importKey(
    'pkcs8', bytes, { name: 'Ed25519' }, false, ['sign'],
  )
}

/**
 * Signs a licence.
 *
 * The signature is taken over the base64url text rather than the JSON, which
 * is the same thing `verifyToken` checks and the reason it does not matter
 * that two JSON encoders disagree about spacing.
 */
export async function signToken(
  key: webcrypto.CryptoKey, token: LicenceToken,
): Promise<string> {
  const payload = encodePayload(token)
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: 'Ed25519' }, key, new TextEncoder().encode(payload),
  ))
  return `${payload}.${toBase64Url(signature)}`
}

/**
 * The public half of a private key, so `portal keygen` is not the only way to
 * recover what to paste into a build.
 *
 * WebCrypto will not export a public key from a PKCS#8 private one, and the
 * last 32 bytes of an Ed25519 PKCS#8 blob are the public key only by
 * convention of the encoding rather than by any rule this code should lean
 * on. So this signs a known message and hands back the signature for the
 * caller to check against a candidate, rather than pretending to derive
 * anything.
 */
export const KEY_PROOF_MESSAGE = 'shopos-licence-key-proof'

export async function proveKey(key: webcrypto.CryptoKey): Promise<string> {
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: 'Ed25519' }, key, new TextEncoder().encode(KEY_PROOF_MESSAGE),
  ))
  return toBase64Url(signature)
}
