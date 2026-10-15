import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { webcrypto, randomBytes } from 'node:crypto'
import { toBase64Url, type SigningKey } from '../src/domain/licence.js'
import { verifyPack, type Repair } from '../src/domain/repairPack.js'
import { checkPack, applyPack } from '../src/services/repair.js'
import { REPAIR_KEYS } from '../src/config/repairs.js'
import { getSetting } from '../src/services/settings.js'
import { nextDocNo } from '../src/services/numbering.js'
import { createUser } from '../src/services/auth.js'
import { PermissionError } from '../src/integrity/permissions.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * A fix support made for one shop: refused unless it is the vendor's, for
 * this shop, in date and unused; said in words before anything changes; and
 * done as a set of named operations, each in the audit, or not at all.
 *
 * Real Ed25519 throughout, verified by the code the till runs, against a key
 * the test made -- the build's own list (`config/repairs.ts`) has no key a test
 * could sign with, which is the point of it.
 */

const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair
const KEYS: SigningKey[] = [{ kid: 'repair-test', publicKey: toBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))) }]
const other = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair

const NOW = new Date('2026-10-16T10:00:00Z')

async function sign(payload: Record<string, unknown>, key = pair.privateKey): Promise<string> {
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(encoded)))
  return `${encoded}.${toBase64Url(sig)}`
}

function pack(shopId: string, repairs: Repair[], over: Record<string, unknown> = {}) {
  return {
    format: 1, id: randomBytes(16).toString('hex'), kid: 'repair-test', shopId,
    issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    ticket: 'ticket 142: counter held by a dead till', repairs, ...over,
  }
}

let fx: Fixture
let shopId: string
beforeEach(async () => {
  fx = await freshDb()
  shopId = (await getSetting(fx.db, 'shop_id'))!
})
afterEach(async () => { await fx.db.close() })

describe('the pack itself', () => {
  const free: Repair[] = [{ kind: 'retry_set_aside' }]

  it('is taken when it is the vendor\'s, for this shop, and in date', async () => {
    const result = await verifyPack(await sign(pack('shop-a', free)), KEYS, { shopId: 'shop-a', now: NOW })
    expect(result.ok).toBe(true)
  })

  it('is refused signed by anybody else, or changed after signing', async () => {
    expect((await verifyPack(await sign(pack('shop-a', free), other.privateKey), KEYS, { shopId: 'shop-a', now: NOW })).ok).toBe(false)
    const genuine = await sign(pack('shop-a', free))
    const [body, sig] = genuine.split('.')
    const changed = toBase64Url(new TextEncoder().encode(
      new TextDecoder().decode(Buffer.from(body!, 'base64url')).replace('shop-a', 'shop-b')))
    expect(await verifyPack(`${changed}.${sig}`, KEYS, { shopId: 'shop-b', now: NOW })).toMatchObject({ code: 'BAD_SIGNATURE' })
  })

  it('is refused at another shop, after its date, or naming a key this build does not have', async () => {
    expect(await verifyPack(await sign(pack('shop-a', free)), KEYS, { shopId: 'shop-b', now: NOW })).toMatchObject({ code: 'WRONG_SHOP' })
    const later = new Date(NOW.getTime() + 8 * 86_400_000)
    expect(await verifyPack(await sign(pack('shop-a', free)), KEYS, { shopId: 'shop-a', now: later })).toMatchObject({ code: 'EXPIRED' })
    expect(await verifyPack(await sign(pack('shop-a', free, { kid: 'old' })), KEYS, { shopId: 'shop-a', now: NOW })).toMatchObject({ code: 'UNKNOWN_KEY' })
  })

  it('cannot ask for anything this build does not know how to do', async () => {
    const sneaky = pack('shop-a', [{ kind: 'run_sql', sql: 'DELETE FROM bills' } as unknown as Repair])
    expect(await verifyPack(await sign(sneaky), KEYS, { shopId: 'shop-a', now: NOW })).toMatchObject({ code: 'MALFORMED' })
  })

  it('says NOT_CONFIGURED, not a bad signature, in a build with no repair keys', async () => {
    expect(await verifyPack(await sign(pack('shop-a', free)), [], { shopId: 'shop-a', now: NOW })).toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('ships no key but a real one: each is 32 bytes of Ed25519', () => {
    for (const key of REPAIR_KEYS) expect(Buffer.from(key.publicKey, 'base64url')).toHaveLength(32)
  })
})

describe('applying a pack', () => {
  async function aGhostCounter(): Promise<string> {
    await fx.db.execute(`UPDATE registers SET claimed_by = 'dead-till-0000' WHERE id = ?`, [fx.seed.registerId])
    return fx.seed.registerId
  }

  it('says what it will do before doing it, and does nothing while it says', async () => {
    const registerId = await aGhostCounter()
    const checked = await checkPack(fx.db, await sign(pack(shopId, [{ kind: 'free_counter', registerId }])), { now: NOW, keys: KEYS })
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.previews[0]!.says).toMatch(/Let go of counter .* held by till dead-til/)
    const still = await fx.db.get<{ claimed_by: string | null }>('SELECT claimed_by FROM registers WHERE id = ?', [registerId])
    expect(still?.claimed_by).toBe('dead-till-0000')
  })

  it('frees the counter, writes the audit, and is used once for the whole shop', async () => {
    const registerId = await aGhostCounter()
    const raw = await sign(pack(shopId, [{ kind: 'free_counter', registerId }]))
    const applied = await applyPack(fx.db, { raw, actorId: fx.adminId, now: NOW, keys: KEYS })
    expect(applied.ok).toBe(true)

    const row = await fx.db.get<{ claimed_by: string | null }>('SELECT claimed_by FROM registers WHERE id = ?', [registerId])
    expect(row?.claimed_by).toBeNull()
    const audit = await fx.db.get<{ diff: string }>(`SELECT diff FROM audit_log WHERE entity_id = 'repair_pack'`)
    expect(audit?.diff).toContain('ticket 142')

    expect(await applyPack(fx.db, { raw, actorId: fx.adminId, now: NOW, keys: KEYS })).toMatchObject({ ok: false, code: 'USED' })
  })

  it('moves a counter\'s numbers past one issued elsewhere, and never back', async () => {
    const prefix = (await fx.db.get<{ prefix: string }>('SELECT prefix FROM registers WHERE id = ?', [fx.seed.registerId]))!.prefix
    const raw = await sign(pack(shopId, [{ kind: 'renumber_from', docType: 'bill', prefix, fiscalYear: '2627', next: 43 }]))
    expect((await applyPack(fx.db, { raw, actorId: fx.adminId, now: NOW, keys: KEYS })).ok).toBe(true)
    const no = await fx.db.transaction((tx) => nextDocNo(tx, 'bill', prefix, NOW))
    expect(no).toBe(`B${prefix}/2627/00043`)

    const back = await sign(pack(shopId, [{ kind: 'renumber_from', docType: 'bill', prefix, fiscalYear: '2627', next: 5 }]))
    const checked = await checkPack(fx.db, back, { now: NOW, keys: KEYS })
    expect(checked.ok && checked.previews[0]!.says).toMatch(/Already past number 5/)
  })

  it('recounts a figure that drifted, having said how many would change', async () => {
    const productId = await makeProduct(fx.db)
    await fx.db.execute('INSERT OR REPLACE INTO product_stock (product_id, qty_on_hand, stock_value, updated_at) VALUES (?, 990000, 0, ?)', [productId, NOW.toISOString()])
    const raw = await sign(pack(shopId, [{ kind: 'reconcile', what: 'stock' }]))
    const checked = await checkPack(fx.db, raw, { now: NOW, keys: KEYS })
    expect(checked.ok && checked.previews[0]!.says).toContain('stock on hand 1')
    expect((await applyPack(fx.db, { raw, actorId: fx.adminId, now: NOW, keys: KEYS })).ok).toBe(true)
    const after = await fx.db.get<{ qty_on_hand: number }>('SELECT qty_on_hand FROM product_stock WHERE product_id = ?', [productId])
    expect(after?.qty_on_hand).toBe(0)
  })

  it('applies none of a pack with any part that does not fit this shop', async () => {
    const registerId = await aGhostCounter()
    await fx.db.execute(`INSERT INTO sync_peers (device_id, label, their_cursor, my_cursor, created_at) VALUES ('peer-1', 'Front', 100, 0, ?)`, [NOW.toISOString()])
    const raw = await sign(pack(shopId, [
      { kind: 'free_counter', registerId },
      { kind: 'reset_peer_cursor', deviceId: 'peer-1', from: 500 },
    ]))
    const applied = await applyPack(fx.db, { raw, actorId: fx.adminId, now: NOW, keys: KEYS })
    expect(applied).toMatchObject({ ok: false, code: 'DOES_NOT_FIT' })
    const row = await fx.db.get<{ claimed_by: string | null }>('SELECT claimed_by FROM registers WHERE id = ?', [registerId])
    expect(row?.claimed_by).toBe('dead-till-0000')
  })

  it('asks a peer for its changes again from an earlier point', async () => {
    await fx.db.execute(`INSERT INTO sync_peers (device_id, label, their_cursor, my_cursor, created_at) VALUES ('peer-1', 'Front', 100, 0, ?)`, [NOW.toISOString()])
    const raw = await sign(pack(shopId, [{ kind: 'reset_peer_cursor', deviceId: 'peer-1', from: 40 }]))
    expect((await applyPack(fx.db, { raw, actorId: fx.adminId, now: NOW, keys: KEYS })).ok).toBe(true)
    expect(await fx.db.get('SELECT their_cursor FROM sync_peers WHERE device_id = ?', ['peer-1'])).toEqual({ their_cursor: 40 })
  })

  it('is not for somebody who may not change settings', async () => {
    const roles = await fx.db.query<{ id: string; name: string }>('SELECT id, name FROM roles')
    const cashier = roles.find((r) => r.name !== 'Admin')!
    const made = await createUser(fx.db, { username: 'cash1', password: 'cashier-pass-9', roleId: cashier.id, actorId: fx.adminId })
    if (!made.ok) throw new Error('no user')
    const raw = await sign(pack(shopId, [{ kind: 'retry_set_aside' }]))
    await expect(applyPack(fx.db, { raw, actorId: made.userId, now: NOW, keys: KEYS })).rejects.toBeInstanceOf(PermissionError)
  })
})
