import type { SigningKey } from '../domain/licence.js'

/**
 * The public keys this build will accept a repair pack from
 * (`domain/repairPack.ts`). **Edit this file when you have one.**
 *
 * A separate key from the licence key, made by a separate command, and kept
 * apart from it: a leaked licence key mints licences, which costs the vendor
 * money; a leaked repair key changes shops' books, which costs the shops.
 *
 *     npx tsx tools/support/keygen.ts --repair
 *     # the line it prints goes here; the private half stays offline
 *
 * Empty until then, and empty is honest: every pack is refused as
 * NOT_CONFIGURED, naming this file, rather than as a bad signature, which
 * would send somebody looking for a forger.
 *
 * Raw Ed25519, 32 bytes, base64url. A list, so a new key can ship before the
 * old one is retired.
 */
export const REPAIR_KEYS: readonly SigningKey[] = [
  { kid: 'shopos-repair-2026', publicKey: 'pIPKdXy9IsCkBE2UW2vcKrarTLO3u_Wn6nr9nmP982g' },
]
