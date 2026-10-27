import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { documentToCart } from '../src/services/convert.js'
import { loadDocument } from '../src/services/documents.js'
import { setProductActive } from '../src/services/products.js'
import { setSetting } from '../src/services/bootstrap.js'
import { rupees, type Money } from '../src/money.js'
import { newId } from '../src/ids.js'
import { whyNotServing, WEB_SETTINGS } from '../src/services/web/gate.js'
import { buildCatalog, publishCatalog } from '../src/services/web/catalog.js'
import { verifyGoogleIdToken, type Jwks } from '../src/services/web/google.js'
import { issueSession, readSession } from '../src/services/web/session.js'
import { signIn, saveContact, verifyPhone, normalisePhone, loadAccount } from '../src/services/web/accounts.js'
import {
  placeOrder, acceptWebOrder, rejectWebOrder, markWebOrder, cancelWebOrder, customerCancel, expireUnanswered,
  MAX_OPEN_ORDERS,
} from '../src/services/web/orders.js'
import { loadWebOrder, orderForAccount, reviewWebOrder } from '../src/services/web/orderViews.js'
import { handleWebRequest, newThrottles, type WebDeps } from '../src/services/web/routes.js'
import { setProductPhoto, removeProductPhoto, listedWithoutPhoto } from '../src/services/web/photos.js'
import { listedCategoryIds } from '../src/services/web/catalog.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * Orders from the storefront (`services/web/`): which shop and till may take
 * them, what the catalogue lists and charges, who a signed-in customer is, and
 * an order from arriving to being collected at the counter.
 */

const SHOP = '01a122eb-d2b5-7814-b629-c86ad9bb71ed'
const ORIGIN = 'https://shop.example.in'
const CLIENT = 'test-client.apps.googleusercontent.com'
const NOW = new Date('2026-10-28T06:30:00Z')

let fx: Fixture
let stationery: string
let pen: string
let book: string

async function category(name: string, parentId: string | null = null): Promise<string> {
  const id = newId()
  const at = NOW.toISOString()
  await fx.db.execute(
    `INSERT INTO categories (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, name, parentId, at, at],
  )
  return id
}

async function inCategory(productId: string, categoryId: string): Promise<void> {
  await fx.db.execute(`UPDATE products SET category_id = ? WHERE id = ?`, [categoryId, productId])
}

async function online(): Promise<void> {
  await setSetting(fx.db, 'shop_id', SHOP)
  await setSetting(fx.db, WEB_SETTINGS.enabled, 'on')
  await setSetting(fx.db, WEB_SETTINGS.open, 'on')
  await setSetting(fx.db, WEB_SETTINGS.categories, JSON.stringify([stationery]))
  await setSetting(fx.db, WEB_SETTINGS.origin, ORIGIN)
  await setSetting(fx.db, WEB_SETTINGS.googleClientId, CLIENT)
}

async function customer(sub = 'google-1', phone = '9876543210') {
  const account = await signIn(fx.db, { sub, email: `${sub}@example.com`, name: 'Asha' }, NOW)
  const saved = await saveContact(fx.db, account.id, { name: 'Asha', phone }, NOW)
  if (!saved.ok) throw new Error(saved.code)
  return saved.account
}

async function order(accountId: string, lines = [{ productId: pen, unit: 'piece', qty: 2, price: 10000 }], id = newId()) {
  const placed = await placeOrder(fx.db, { accountId, clientOrderId: id.replace(/[^A-Za-z0-9-]/g, ''), lines }, NOW)
  if (!placed.ok) throw new Error(placed.code)
  return placed.order
}

beforeEach(async () => {
  fx = await freshDb()
  stationery = await category('Stationery')
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
  book = await makeProduct(fx.db, { name: 'Book', baseRate: rupees(50), taxRateBp: 0 })
  await inCategory(pen, stationery)
  await inCategory(book, stationery)
  await online()
})
afterEach(async () => { await fx.db.close() })

describe('who answers the web', () => {
  it('is only a listed shop, with the setting on, on the main or a till on its own', async () => {
    expect(await whyNotServing(fx.db)).toBeNull()

    await setSetting(fx.db, WEB_SETTINGS.enabled, 'off')
    expect(await whyNotServing(fx.db)).toBe('TURNED_OFF')
    await setSetting(fx.db, WEB_SETTINGS.enabled, 'on')

    await setSetting(fx.db, 'shop_id', 'ffffffff-0000-0000-0000-000000000000')
    expect(await whyNotServing(fx.db)).toBe('NOT_THIS_SHOP')
    await setSetting(fx.db, 'shop_id', SHOP)

    /* Another till is the main. */
    await fx.db.execute(`UPDATE sync_state SET main_device = 'some-other-till', main_epoch = 1 WHERE id = 1`)
    expect(await whyNotServing(fx.db)).toBe('NOT_THE_MAIN')
  })

  it('refuses every route when it may not', async () => {
    await setSetting(fx.db, WEB_SETTINGS.enabled, 'off')
    for (const path of ['/api/status', '/catalog/manifest.json', '/api/orders']) {
      const reply = await handleWebRequest(fx.db, { method: 'GET', path, headers: {}, body: '' }, deps())
      expect(reply.status).toBe(503)
    }
  })
})

describe('the catalogue', () => {
  it('lists items in the chosen categories and their children, priced as the counter would, with tax in', async () => {
    const pens = await category('Pens', stationery)
    const gel = await makeProduct(fx.db, { name: 'Gel pen', baseRate: rupees(20) })
    await inCategory(gel, pens)
    const elsewhere = await makeProduct(fx.db, { name: 'Rice' })
    await inCategory(elsewhere, await category('Grocery'))

    const catalog = await buildCatalog(fx.db, NOW)
    expect(catalog.items.map((i) => i.name)).toEqual(['Book', 'Gel pen', 'Pen'])
    expect(catalog.items.find((i) => i.name === 'Pen')?.units).toEqual([{ unit: 'piece', price: rupees(100), mrp: null }])
  })

  it('leaves out retired items and gives a box its own line', async () => {
    await setProductActive(fx.db, { actorId: fx.adminId }, book, false)
    await fx.db.execute(
      `INSERT INTO product_units (id, product_id, sale_unit, base_units, created_at, updated_at) VALUES (?, ?, 'box', 100000, ?, ?)`,
      [newId(), pen, NOW.toISOString(), NOW.toISOString()],
    )
    const catalog = await buildCatalog(fx.db, NOW)
    expect(catalog.items.map((i) => i.name)).toEqual(['Pen'])
    expect(catalog.items[0]!.units.map((u) => [u.unit, u.price])).toEqual([['piece', rupees(100)], ['box', rupees(1000)]])
  })

  it('is named by its content: the same catalogue the same name, a new price a new one', async () => {
    const first = await publishCatalog(fx.db, NOW)
    expect((await publishCatalog(fx.db, new Date(NOW.getTime() + 60_000))).hash).toBe(first.hash)
    await fx.db.execute(`UPDATE products SET base_rate = ? WHERE id = ?`, [rupees(120), pen])
    expect((await publishCatalog(fx.db, NOW)).hash).not.toBe(first.hash)
  })

  it('serves the manifest briefly and the named file for ever', async () => {
    const manifest = await handleWebRequest(fx.db, { method: 'GET', path: '/catalog/manifest.json', headers: {}, body: '' }, deps())
    expect(manifest.headers['cache-control']).toContain('s-maxage=60')
    const { hash } = JSON.parse(manifest.body) as { hash: string }
    const file = await handleWebRequest(fx.db, { method: 'GET', path: `/catalog/${hash}.json`, headers: {}, body: '' }, deps())
    expect(file.status).toBe(200)
    expect(file.headers['cache-control']).toContain('immutable')
    const stale = await handleWebRequest(fx.db, { method: 'GET', path: `/catalog/${'0'.repeat(64)}.json`, headers: {}, body: '' }, deps())
    expect(stale.status).toBe(404)
  })
})

describe("an item's photo", () => {
  const stored = (sha: string) => ({ fileName: 'photo.webp', mime: 'image/webp', sizeBytes: 100, sha256: sha, storedPath: `${sha.slice(0, 2)}/${sha}.webp` })

  it('goes into the catalogue in two sizes, and off the list of items without one', async () => {
    expect((await listedWithoutPhoto(fx.db, await listedCategoryIds(fx.db))).map((p) => p.name)).toEqual(['Book', 'Pen'])
    const big = 'a'.repeat(64)
    const small = 'b'.repeat(64)
    await setProductPhoto(fx.db, { actorId: fx.adminId }, { productId: pen, photo: stored(big), thumb: stored(small) })
    const item = (await buildCatalog(fx.db, NOW)).items.find((i) => i.name === 'Pen')
    expect(item).toMatchObject({ photo: big, thumb: small })
    expect((await listedWithoutPhoto(fx.db, await listedCategoryIds(fx.db))).map((p) => p.name)).toEqual(['Book'])
  })

  it('hands back the files nothing points at once it is replaced or removed', async () => {
    await setProductPhoto(fx.db, { actorId: fx.adminId }, { productId: pen, photo: stored('c'.repeat(64)), thumb: stored('d'.repeat(64)) })
    const replaced = await setProductPhoto(fx.db, { actorId: fx.adminId }, { productId: pen, photo: stored('e'.repeat(64)), thumb: stored('d'.repeat(64)) })
    expect(replaced.orphaned).toEqual([`cc/${'c'.repeat(64)}.webp`])
    const removed = await removeProductPhoto(fx.db, { actorId: fx.adminId }, pen)
    expect(removed.orphaned.sort()).toEqual([`dd/${'d'.repeat(64)}.webp`, `ee/${'e'.repeat(64)}.webp`])
    expect((await buildCatalog(fx.db, NOW)).items.find((i) => i.name === 'Pen')?.photo).toBeNull()
  })
})

describe('signing in with Google', () => {
  it('takes a token Google signed for this storefront, and nothing else', async () => {
    const google = await fakeGoogle()
    const good = await google.token({ aud: CLIENT })
    expect(await verifyGoogleIdToken(good, google.jwks, CLIENT, NOW)).toMatchObject({ ok: true, identity: { sub: 'google-1' } })
    expect(await verifyGoogleIdToken(await google.token({ aud: 'someone-else' }), google.jwks, CLIENT, NOW))
      .toMatchObject({ ok: false, code: 'WRONG_AUDIENCE' })
    expect(await verifyGoogleIdToken(await google.token({ exp: secondsOf(NOW) - 3600 }), google.jwks, CLIENT, NOW))
      .toMatchObject({ ok: false, code: 'EXPIRED' })
    expect(await verifyGoogleIdToken(await google.token({ iss: 'https://evil.example' }), google.jwks, CLIENT, NOW))
      .toMatchObject({ ok: false, code: 'WRONG_ISSUER' })
    expect(await verifyGoogleIdToken(await google.token({ email_verified: false }), google.jwks, CLIENT, NOW))
      .toMatchObject({ ok: false, code: 'EMAIL_NOT_VERIFIED' })

    const forger = await fakeGoogle()
    expect(await verifyGoogleIdToken(await forger.token({}), google.jwks, CLIENT, NOW))
      .toMatchObject({ ok: false, code: 'BAD_SIGNATURE' })
  })

  it('makes one account per Google identity, whatever its email becomes', async () => {
    const a = await signIn(fx.db, { sub: 'g-7', email: 'old@example.com', name: 'Ravi' }, NOW)
    const b = await signIn(fx.db, { sub: 'g-7', email: 'new@example.com', name: 'Ravi' }, NOW)
    expect(b.id).toBe(a.id)
    expect(b.email).toBe('new@example.com')
  })

  it('gives a session the till can read back, and refuses one altered or expired', async () => {
    const token = await issueSession(fx.db, 'acct-1', NOW)
    expect(await readSession(fx.db, token, NOW)).toMatchObject({ accountId: 'acct-1' })
    const [payload, mac] = token.split('.') as [string, string]
    expect(await readSession(fx.db, `${payload}x.${mac}`, NOW)).toBeNull()
    expect(await readSession(fx.db, token, new Date(NOW.getTime() + 31 * 86_400_000))).toBeNull()
  })

  it("signs in through the API and answers only the storefront's own origin", async () => {
    const google = await fakeGoogle()
    const reply = await handleWebRequest(fx.db, {
      method: 'POST', path: '/api/session', headers: { origin: ORIGIN },
      body: JSON.stringify({ idToken: await google.token({}) }),
    }, deps({ googleKeys: google.jwks }))
    expect(reply.status).toBe(200)
    expect(reply.headers['access-control-allow-origin']).toBe(ORIGIN)
    const { session } = JSON.parse(reply.body) as { session: string }
    const me = await handleWebRequest(fx.db, {
      method: 'GET', path: '/api/me', headers: { authorization: `Bearer ${session}`, origin: 'https://elsewhere.example' }, body: '',
    }, deps())
    expect(me.status).toBe(200)
    expect(me.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('a phone number', () => {
  it('is ten digits whichever way it was typed', () => {
    expect(normalisePhone('+91 98765 43210')).toBe('9876543210')
    expect(normalisePhone('09876543210')).toBe('9876543210')
    expect(normalisePhone('12345')).toBeNull()
    expect(normalisePhone('5876543210')).toBeNull()
  })

  it('has to be checked again when it changes', async () => {
    const account = await customer()
    await verifyPhone(fx.db, { accountId: account.id, actorId: fx.adminId })
    expect((await loadAccount(fx.db, account.id))?.phoneVerified).toBe(true)
    await saveContact(fx.db, account.id, { name: 'Asha', phone: '9123456780' }, NOW)
    expect((await loadAccount(fx.db, account.id))?.phoneVerified).toBe(false)
  })
})

describe('placing an order', () => {
  it('is one order however many times the phone sends it', async () => {
    const account = await customer()
    const lines = [{ productId: pen, unit: 'piece', qty: 2, price: 10000 }]
    const a = await placeOrder(fx.db, { accountId: account.id, clientOrderId: 'order-abc-123', lines }, NOW)
    const b = await placeOrder(fx.db, { accountId: account.id, clientOrderId: 'order-abc-123', lines }, NOW)
    expect(a.ok && b.ok && a.order.id === b.order.id).toBe(true)
    if (a.ok) expect(a.order).toMatchObject({ orderNo: 1, status: 'pending', seenTotal: rupees(200) })
  })

  it('is refused without a name and phone, for an item not listed, and past the open-order cap', async () => {
    const nobody = await signIn(fx.db, { sub: 'g-x', email: null, name: null }, NOW)
    expect(await placeOrder(fx.db, { accountId: nobody.id, clientOrderId: 'order-0001', lines: [] }, NOW))
      .toMatchObject({ ok: false, code: 'NO_CONTACT' })

    const account = await customer()
    const rice = await makeProduct(fx.db, { name: 'Rice' })
    expect(await placeOrder(fx.db, {
      accountId: account.id, clientOrderId: 'order-0002', lines: [{ productId: rice, unit: 'piece', qty: 1, price: 100 }],
    }, NOW)).toMatchObject({ ok: false, code: 'NOT_LISTED', productId: rice })

    for (let i = 0; i < MAX_OPEN_ORDERS; i++) await order(account.id)
    expect(await placeOrder(fx.db, {
      accountId: account.id, clientOrderId: 'order-0003', lines: [{ productId: pen, unit: 'piece', qty: 1, price: 100 }],
    }, NOW)).toMatchObject({ ok: false, code: 'TOO_MANY_OPEN' })
  })

  it('is refused through the API while the shop is closed', async () => {
    const account = await customer()
    const session = await issueSession(fx.db, account.id, NOW)
    await setSetting(fx.db, WEB_SETTINGS.open, 'off')
    const reply = await handleWebRequest(fx.db, {
      method: 'POST', path: '/api/orders', headers: { authorization: `Bearer ${session}` },
      body: JSON.stringify({ clientOrderId: 'order-closed-1', lines: [{ productId: pen, unit: 'piece', qty: 1, price: 10000 }] }),
    }, deps())
    expect(reply.status).toBe(409)
  })
})

describe('what the storefront is told', () => {
  it("gives the shop's address, phone and hours with its state, and names a line with its brand", async () => {
    await setSetting(fx.db, 'shop_address', '12 Car Street, Madurai')
    await setSetting(fx.db, 'shop_phone', '0452 123456')
    await setSetting(fx.db, WEB_SETTINGS.hours, '9 am to 9 pm, closed Sunday')
    const reply = await handleWebRequest(fx.db, { method: 'GET', path: '/api/status', headers: {}, body: '' }, deps())
    expect(JSON.parse(reply.body)).toMatchObject({
      state: 'open', about: { address: '12 Car Street, Madurai', phone: '0452 123456', hours: '9 am to 9 pm, closed Sunday' },
    })

    await fx.db.execute(`UPDATE products SET brand = 'Cello' WHERE id = ?`, [pen])
    const placed = await order((await customer()).id)
    expect(placed.lines[0]!.name).toBe('Pen (Cello)')
  })
})

describe('an order answered and collected', () => {
  it('becomes a submitted sales order priced by the till, and is collected when it is billed', async () => {
    const account = await customer()
    const placed = await order(account.id, [{ productId: pen, unit: 'piece', qty: 2, price: 9000 }])
    await fx.db.execute(`UPDATE products SET base_rate = ? WHERE id = ?`, [rupees(110), pen])

    const review = await reviewWebOrder(fx.db, placed.id, NOW)
    expect(review?.lines[0]).toMatchObject({ seenPrice: 9000, tillPrice: rupees(110), listed: true })

    const accepted = await acceptWebOrder(fx.db, { webOrderId: placed.id, actorId: fx.adminId, registerId: fx.seed.registerId, now: NOW })
    if (!accepted.ok) throw new Error(accepted.code)
    expect(accepted.tillTotal).toBe(rupees(220))
    const doc = await loadDocument(fx.db, accepted.documentId)
    expect(doc).toMatchObject({ kind: 'sales_order', docstatus: 1, notes: 'Online order #1' })
    expect((await loadWebOrder(fx.db, placed.id))?.status).toBe('accepted')

    expect(await markWebOrder(fx.db, { webOrderId: placed.id, actorId: fx.adminId, to: 'ready' })).toEqual({ ok: true })
    expect((await loadWebOrder(fx.db, placed.id))?.status).toBe('ready')

    const billId = await billOrder(accepted.documentId)
    expect((await loadWebOrder(fx.db, placed.id))?.status).toBe('collected')

    await cancelBill(fx.db, { billId, reason: 'Wrong customer', actorId: fx.adminId })
    expect((await loadWebOrder(fx.db, placed.id))?.status).toBe('ready')
  })

  it('never bills an unchecked phone to the shop customer who has that number', async () => {
    const regular = await makeCustomer(fx.db, 'Regular on khata')
    await fx.db.execute(`UPDATE customers SET phone = '9876543210' WHERE id = ?`, [regular])
    const account = await customer('g-stranger', '9876543210')

    const first = await order(account.id)
    const accepted = await acceptWebOrder(fx.db, { webOrderId: first.id, actorId: fx.adminId, registerId: fx.seed.registerId, now: NOW })
    if (!accepted.ok) throw new Error(accepted.code)
    expect((await loadDocument(fx.db, accepted.documentId))?.customerId).not.toBe(regular)

    /* Checked at the counter, a later account with that number is that customer. */
    const checked = await customer('g-regular', '9876543210')
    await verifyPhone(fx.db, { accountId: checked.id, actorId: fx.adminId })
    const second = await order(checked.id)
    const again = await acceptWebOrder(fx.db, { webOrderId: second.id, actorId: fx.adminId, registerId: fx.seed.registerId, now: NOW })
    if (!again.ok) throw new Error(again.code)
    expect((await loadDocument(fx.db, again.documentId))?.customerId).toBe(regular)
  })

  it('can be turned away with a reason, and only while it waits', async () => {
    const account = await customer()
    const placed = await order(account.id)
    expect(await rejectWebOrder(fx.db, { webOrderId: placed.id, actorId: fx.adminId, reason: '' }))
      .toMatchObject({ ok: false, code: 'REASON_REQUIRED' })
    expect(await rejectWebOrder(fx.db, { webOrderId: placed.id, actorId: fx.adminId, reason: 'Out of stock' })).toEqual({ ok: true })
    expect(await loadWebOrder(fx.db, placed.id)).toMatchObject({ status: 'rejected', reason: 'Out of stock' })
    expect(await acceptWebOrder(fx.db, { webOrderId: placed.id, actorId: fx.adminId, registerId: fx.seed.registerId }))
      .toMatchObject({ ok: false, code: 'NOT_PENDING' })
  })

  it('is cancelled by the customer outright while it waits, and only asked for after', async () => {
    const account = await customer()
    const waiting = await order(account.id)
    expect(await customerCancel(fx.db, { accountId: account.id, orderId: waiting.id, now: NOW }))
      .toMatchObject({ ok: true, order: { status: 'cancelled' } })

    const taken = await order(account.id)
    await acceptWebOrder(fx.db, { webOrderId: taken.id, actorId: fx.adminId, registerId: fx.seed.registerId, now: NOW })
    expect(await customerCancel(fx.db, { accountId: account.id, orderId: taken.id, now: NOW }))
      .toMatchObject({ ok: true, order: { status: 'accepted', cancelRequested: true } })
    expect(await cancelWebOrder(fx.db, { webOrderId: taken.id, actorId: fx.adminId, reason: 'Customer asked' })).toEqual({ ok: true })
    const after = await loadWebOrder(fx.db, taken.id)
    expect(after?.status).toBe('cancelled')
    expect((await loadDocument(fx.db, after!.documentId!))?.docstatus).toBe(2)
  })

  it('is turned away by itself when nobody answers in time', async () => {
    const account = await customer()
    const placed = await order(account.id)
    expect(await expireUnanswered(fx.db, new Date(NOW.getTime() + 10 * 60_000))).toBe(0)
    expect(await expireUnanswered(fx.db, new Date(NOW.getTime() + 31 * 60_000))).toBe(1)
    expect((await loadWebOrder(fx.db, placed.id))?.status).toBe('rejected')
  })

  it("is somebody else's business to nobody else", async () => {
    const mine = await customer('g-mine')
    const theirs = await customer('g-theirs', '9123456780')
    const placed = await order(mine.id)
    expect(await orderForAccount(fx.db, theirs.id, placed.id)).toBeNull()
    const session = await issueSession(fx.db, theirs.id, NOW)
    const reply = await handleWebRequest(fx.db, {
      method: 'GET', path: `/api/orders/${placed.id}`, headers: { authorization: `Bearer ${session}` }, body: '',
    }, deps())
    expect(reply.status).toBe(404)
  })
})

describe('the rate limit', () => {
  it('stops one address signing in over and over', async () => {
    const d = deps()
    let last = 0
    for (let i = 0; i < 31; i++) {
      last = (await handleWebRequest(fx.db, {
        method: 'POST', path: '/api/session', headers: { 'cf-connecting-ip': '203.0.113.9' }, body: '{"idToken":"x"}',
      }, d)).status
    }
    expect(last).toBe(429)
  })
})

// ---------------------------------------------------------------- helpers

function deps(over: Partial<WebDeps> = {}): WebDeps {
  return { now: NOW, googleKeys: null, throttles: newThrottles(), ...over }
}

async function billOrder(documentId: string): Promise<string> {
  const loaded = await documentToCart(fx.db, { documentId })
  if (!loaded.ok) throw new Error(loaded.code)
  const d = await createBill(fx.db, {
    registerId: fx.seed.registerId, customerId: loaded.customerId, convertedFrom: loaded.documentId,
    lines: loaded.lines.map((l) => ({
      productId: l.productId, saleUnit: l.saleUnit, qty: l.qty,
      resolved: { rate: l.rate, source: 'order_rate' as const, sourceId: loaded.documentId },
    })),
    actorId: fx.adminId,
  })
  if (!d.ok) throw new Error(d.code)
  const paid = await submitBill(fx.db, { billId: d.billId, payments: [{ method: 'cash', amount: d.grandTotal as Money }], actorId: fx.adminId })
  if (!paid.ok) throw new Error(paid.code)
  return d.billId
}

const secondsOf = (d: Date) => Math.floor(d.getTime() / 1000)

/** A stand-in for Google: an RSA key, its public half as a key set, and tokens signed with it. */
async function fakeGoogle() {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )
  const pub = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)
  const jwks: Jwks = { keys: [{ kid: 'k1', kty: 'RSA', n: pub.n!, e: pub.e!, alg: 'RS256' }] }
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const enc = (o: unknown) => b64(new TextEncoder().encode(JSON.stringify(o)))
  async function token(claims: Record<string, unknown>): Promise<string> {
    const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })
    const body = enc({
      iss: 'https://accounts.google.com', aud: CLIENT, sub: 'google-1', email: 'asha@example.com', email_verified: true,
      name: 'Asha', iat: secondsOf(NOW) - 10, exp: secondsOf(NOW) + 3600, ...claims,
    })
    const sig = await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`))
    return `${head}.${body}.${b64(new Uint8Array(sig))}`
  }
  return { jwks, token }
}
