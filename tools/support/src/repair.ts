import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readPackUnverified, type Pack, type Repair } from '@shopos/core'

/*
 * Repair packs, made and signed on the vendor's machine
 * (`packages/core/src/domain/repairPack.ts` is the till's side).
 *
 * The signing key is the vendor's repair key: Ed25519, its private half in
 * `~/.shopos/repair-key.json` and nowhere else, its public half in
 * `config/repairs.ts` in every build.
 */

export interface RepairKey {
  kid: string
  jwk: { kty: 'OKP'; crv: 'Ed25519'; d: string; x: string }
}

export function makeRepairKey(kid: string): RepairKey {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { kid, jwk: privateKey.export({ format: 'jwk' }) as RepairKey['jwk'] }
}

/** What goes in `REPAIR_KEYS`. */
export function publicEntry(key: RepairKey): { kid: string; publicKey: string } {
  return { kid: key.kid, publicKey: key.jwk.x }
}

/** `free_counter:registerId=01a0…` or `reconcile:what=all`, from the command line. */
export function parseRepairSpec(spec: string): Repair {
  const [kind, rest = ''] = spec.split(/:(.*)/s)
  const fields: Record<string, string | number> = { kind: kind! }
  for (const pair of rest.split(',').filter(Boolean)) {
    const [k, v = ''] = pair.split('=')
    fields[k!.trim()] = /^(next|from)$/.test(k!.trim()) ? Number(v) : v.trim()
  }
  return fields as unknown as Repair
}

export function makePack(
  key: RepairKey,
  input: { shopId: string; ticket: string; repairs: Repair[]; days?: number; now?: Date },
): { raw: string; pack: Pack } {
  const now = input.now ?? new Date()
  const payload = {
    format: 1,
    id: randomBytes(16).toString('hex'),
    kid: key.kid,
    shopId: input.shopId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.days ?? 7) * 86_400_000).toISOString(),
    ticket: input.ticket,
    repairs: input.repairs,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign(null, Buffer.from(encoded), createPrivateKey({ key: key.jwk, format: 'jwk' }))
  const raw = `${encoded}.${signature.toString('base64url')}`
  // The till reads it with this same parser: a pack it would refuse is not made at all.
  const pack = readPackUnverified(raw)
  if (pack === null) throw new Error('That pack would be refused: a repair kind or one of its fields is not one the tills know.')
  return { raw, pack }
}
