import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
  hkdfSync, type KeyObject,
} from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

/*
 * The file a till makes when its owner sends the shop's data to support
 * (`apps/pos/src-tauri/src/support_data.rs`), opened on the vendor's machine.
 *
 *   SHOPOSD1 | the till's one-time X25519 public key (32)
 *   then chunks: u32 length | ChaCha20-Poly1305 ciphertext and tag
 *
 * The key is HKDF-SHA256 of the agreement, salted `shopos-support-data-v1`,
 * with the two public keys as its info. Chunk n's nonce is n; its associated
 * data is 1 on the last chunk and 0 on every other, so a file cut short does
 * not open. Inside: `SOD1` | u32 length | manifest JSON | the database, gzipped.
 *
 * `seal` is here for the tests; the tills seal in Rust.
 */

const MAGIC = Buffer.from('SHOPOSD1')
const PAYLOAD_MAGIC = Buffer.from('SOD1')
const SALT = Buffer.from('shopos-support-data-v1')
const CHUNK = 64 * 1024

export interface Manifest {
  format: number
  shopId: string
  deviceId: string
  appVersion: string
  madeAt: string
  madeBy: string
  note: string
  anonymised: boolean
  customersHidden: number
}

export interface VendorKey {
  /** The private half, as a JWK: `{ kty: 'OKP', crv: 'X25519', d, x }`. */
  jwk: { kty: 'OKP'; crv: 'X25519'; d: string; x: string }
}

export function makeVendorKey(): VendorKey {
  const { privateKey } = generateKeyPairSync('x25519')
  return { jwk: privateKey.export({ format: 'jwk' }) as VendorKey['jwk'] }
}

/** What goes in `SHOPOS_SUPPORT_PUBKEY`: the public half, raw, base64url. */
export function publicOf(key: VendorKey): string {
  return key.jwk.x
}

function nonce(i: number): Buffer {
  const n = Buffer.alloc(12)
  n.writeBigUInt64BE(BigInt(i), 4)
  return n
}

function derive(shared: Buffer, theirs: Buffer, vendor: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, SALT, Buffer.concat([theirs, vendor]), 32))
}

function x25519Public(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' })
}

export function open(file: Buffer, key: VendorKey): { manifest: Manifest; db: Buffer } {
  if (file.length < 40 || !file.subarray(0, 8).equals(MAGIC)) throw new Error('This is not a ShopOS data file.')
  const theirs = file.subarray(8, 40)
  const vendor = Buffer.from(key.jwk.x, 'base64url')
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: key.jwk, format: 'jwk' }),
    publicKey: x25519Public(theirs),
  })
  const k = derive(shared, theirs, vendor)

  const parts: Buffer[] = []
  let at = 40
  let i = 0
  let sawLast = false
  while (at < file.length) {
    if (at + 4 > file.length) throw new Error('The file is cut short.')
    const len = file.readUInt32BE(at)
    at += 4
    if (len < 16 || at + len > file.length) throw new Error('The file is cut short.')
    const last = at + len === file.length
    const decipher = createDecipheriv('chacha20-poly1305', k, nonce(i), { authTagLength: 16 })
    decipher.setAAD(Buffer.from([last ? 1 : 0]), { plaintextLength: len - 16 })
    decipher.setAuthTag(file.subarray(at + len - 16, at + len))
    try {
      parts.push(decipher.update(file.subarray(at, at + len - 16)), decipher.final())
    } catch {
      throw new Error('This file does not open with this key, or it was changed on the way.')
    }
    sawLast = last
    at += len
    i += 1
  }
  if (!sawLast) throw new Error('The file is cut short.')

  const payload = Buffer.concat(parts)
  if (!payload.subarray(0, 4).equals(PAYLOAD_MAGIC)) throw new Error('The file opened but holds something else.')
  const mlen = payload.readUInt32BE(4)
  const manifest = JSON.parse(payload.subarray(8, 8 + mlen).toString('utf8')) as Manifest
  return { manifest, db: gunzipSync(payload.subarray(8 + mlen)) }
}

/** The tills' side, for tests. */
export function seal(manifest: Manifest, db: Buffer, vendorPublic: string): Buffer {
  const vendor = Buffer.from(vendorPublic, 'base64url')
  const mine = generateKeyPairSync('x25519')
  const minePublic = Buffer.from((mine.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  const k = derive(diffieHellman({ privateKey: mine.privateKey, publicKey: x25519Public(vendor) }), minePublic, vendor)

  const m = Buffer.from(JSON.stringify(manifest))
  const head = Buffer.alloc(8)
  PAYLOAD_MAGIC.copy(head, 0)
  head.writeUInt32BE(m.length, 4)
  const plain = Buffer.concat([head, m, gzipSync(db)])

  const out: Buffer[] = [MAGIC, minePublic]
  const count = Math.max(1, Math.ceil(plain.length / CHUNK))
  for (let i = 0; i < count; i += 1) {
    const chunk = plain.subarray(i * CHUNK, (i + 1) * CHUNK)
    const cipher = createCipheriv('chacha20-poly1305', k, nonce(i), { authTagLength: 16 })
    cipher.setAAD(Buffer.from([i === count - 1 ? 1 : 0]), { plaintextLength: chunk.length })
    const sealed = Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(sealed.length)
    out.push(len, sealed)
  }
  return Buffer.concat(out)
}
