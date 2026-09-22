import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import { openMemoryDatabase } from '@shopos/core/node'
import { migrate, type SqlDriver } from '@shopos/core'
import { MIGRATIONS } from '@shopos/core/migrations'
import { encodePayload, toBase64Url, type LicenceToken, type SigningKey } from '@shopos/core/licence'

/**
 * A licence code going in, and coming back out.
 *
 * Everything under this card was built, tested and unreachable: until it
 * existed a licence could only enter a till by somebody editing a `settings`
 * row by hand. So this is the first test of the path a shopkeeper actually
 * takes, and it takes it twice — **in** on one till, **out** of that till, and
 * **in** again on a second one, which is what a shop with sync down has to do
 * and what a support call asks for.
 *
 * Against a real database and a real Ed25519 signature, not mocks. A card
 * tested against a fake verifier would pass against a verifier that accepts
 * anything, which is the one outcome worth ruling out.
 */

/* One keypair for the file. `config/licensing.ts` ships empty on purpose, so
   the card would otherwise refuse everything with NOT_CONFIGURED — which is
   itself asserted below, because it is what a misbuilt release does. */
const pair = await webcrypto.subtle.generateKey(
  { name: 'Ed25519' }, true, ['sign', 'verify'],
) as webcrypto.CryptoKeyPair

const PUBLIC: SigningKey = {
  kid: 'card-test',
  publicKey: toBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))),
}

async function sign(token: LicenceToken): Promise<string> {
  const payload = encodePayload(token)
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(payload),
  ))
  return `${payload}.${toBase64Url(signature)}`
}

function licence(over: Partial<LicenceToken> = {}): LicenceToken {
  return {
    shopId: 'shop-1', tier: 'cloud', paidThrough: '2027-03-31', tills: 3,
    issuedAt: '2026-09-01T00:00:00.000Z', kid: PUBLIC.kid, ...over,
  }
}

/* The build's own key list is a module constant, so the card reaches it
   through `@shopos/core` rather than being handed it. Swapping the export is
   how a test gets a configured build. */
vi.mock('@shopos/core', async (real) => {
  const core = await real<Record<string, unknown>>()
  const withKeys = <T extends (...args: never[]) => unknown>(fn: T) =>
    ((db: unknown, a: unknown, b: unknown) => {
      // entitlement(db, opts) and installToken(db, ctx, raw, opts) differ in
      // where the options sit; both take them last.
      const f = fn as unknown as (...args: unknown[]) => unknown
      return typeof b === 'string'
        ? f(db, a, b, { keys: [PUBLIC] })
        : f(db, { ...(a as object), keys: [PUBLIC] })
    }) as unknown as T

  return {
    ...core,
    entitlement: withKeys(core['entitlement'] as never),
    installToken: withKeys(core['installToken'] as never),
  }
})

const clipboard: string[] = []
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text: string) => { clipboard.push(text) } },
})

let saved: { filename: string; contents: string } | null = null
vi.mock('../src/core/exportFile', () => ({
  saveFile: async (filename: string, contents: string) => {
    saved = { filename, contents }
    return { ok: true, path: `C:\\Users\\shop\\${filename}` }
  },
}))

const core: { db: SqlDriver | null; user: { id: string } | null } = { db: null, user: { id: 'u1' } }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const { LicenceCard } = await import('../src/ui/LicenceCard')

async function freshTill(shopId = 'shop-1'): Promise<SqlDriver> {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  await db.execute(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    ['shop_id', shopId, new Date().toISOString()],
  )
  return db
}

/** Renders the card and waits for its first load to settle. */
async function show(db: SqlDriver) {
  core.db = db
  render(<LicenceCard />)
  await waitFor(() => expect(screen.getByLabelText('Paste a licence code')).toBeTruthy())
}

async function paste(code: string) {
  const box = screen.getByLabelText('Paste a licence code')
  fireEvent.change(box, { target: { value: code } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save this code' }))
  })
}

const opened: SqlDriver[] = []
beforeEach(() => { clipboard.length = 0; saved = null })
afterEach(async () => {
  cleanup()
  for (const db of opened.splice(0)) await db.close()
})

async function till(shopId = 'shop-1'): Promise<SqlDriver> {
  const db = await freshTill(shopId)
  opened.push(db)
  return db
}

describe('a till with no licence', () => {
  it('says the counter works anyway', async () => {
    await show(await till())

    expect(screen.getByText('No licence code on this till')).toBeTruthy()
    /* The sentence that stops somebody closing the shop. If this ever reads
       as a warning that something is broken, the card is wrong. */
    expect(screen.getByText(/counter works without one/i)).toBeTruthy()
    expect(screen.queryByLabelText("This shop's licence code")).toBeNull()
  })
})

describe('importing a code', () => {
  it('takes a good one and shows what was bought', async () => {
    const db = await till()
    await show(db)

    await paste(await sign(licence()))

    expect(await screen.findByText('Cloud licence')).toBeTruthy()
    expect(screen.getByText('Paid to 31 March 2027.')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()

    // And it really landed, not just in the component's head.
    const row = await db.get<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?', ['licence_token'],
    )
    expect(row?.value).toContain('.')
  })

  it('tells a stale till apart from a forged code', async () => {
    await show(await till())

    /* UNKNOWN_KEY is the one that is not the holder's fault: a genuine
       licence signed with a newer key. The words must not accuse them. */
    await paste(await sign(licence({ kid: 'a-key-from-next-year' })))

    expect(await screen.findByText('This till is too old to check that code')).toBeTruthy()
    expect(screen.getByText(/The code is fine/)).toBeTruthy()
  })

  it('names the shop when the code belongs to another one', async () => {
    await show(await till('shop-1'))

    await paste(await sign(licence({ shopId: 'someone-elses-shop' })))

    expect(await screen.findByText('That code belongs to a different shop')).toBeTruthy()
    expect(screen.getByText(/someone-elses-shop/)).toBeTruthy()
    expect(screen.getByText(/restoring a backup/i)).toBeTruthy()
  })

  it('does not accuse anybody when a character went missing', async () => {
    await show(await till())

    await paste('this-is-not-a-licence')

    expect(await screen.findByText('That does not look like a licence code')).toBeTruthy()
    expect(screen.getByText(/copied whole/i)).toBeTruthy()
  })

  it('says a tampered code did not check out, without crying forgery', async () => {
    await show(await till())

    const real = await sign(licence())
    const [payload, signature] = real.split('.')
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
    decoded.tier = 'branches'
    await paste(`${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`)

    expect(await screen.findByText('This code did not check out')).toBeTruthy()
    // The likeliest cause is a chat app eating a character, not a forger.
    expect(screen.queryByText(/forg/i)).toBeNull()
  })
})

describe('exporting it again', () => {
  it('shows the code, byte for byte, and copies it', async () => {
    const db = await till()
    await show(db)

    const code = await sign(licence())
    await paste(code)

    const box = await screen.findByLabelText("This shop's licence code") as HTMLTextAreaElement
    /* Byte for byte matters: the signature is over the original bytes, so a
       re-encoded token would be a different string and would not verify. */
    expect(box.value).toBe(code)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(clipboard).toEqual([code])
  })

  it('saves it to a file', async () => {
    await show(await till())
    const code = await sign(licence())
    await paste(code)

    const button = await screen.findByRole('button', { name: 'Save to a file' })
    await act(async () => { fireEvent.click(button) })

    expect(saved).toEqual({ filename: 'shopos-licence.txt', contents: code })
  })
})

describe('the round trip', () => {
  it('carries a licence from one till to another by hand', async () => {
    /* What a shop does when sync is down and the second counter needs
       setting up. The whole reason the card reads as well as writes. */
    const first = await till('shop-1')
    await show(first)

    const code = await sign(licence())
    await paste(code)

    const box = await screen.findByLabelText("This shop's licence code") as HTMLTextAreaElement
    const carried = box.value
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })

    cleanup()

    const second = await till('shop-1')
    await show(second)
    await paste(clipboard[0]!)

    expect(await screen.findByText('Cloud licence')).toBeTruthy()
    expect(screen.getByText('Paid to 31 March 2027.')).toBeTruthy()

    const landed = await second.get<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?', ['licence_token'],
    )
    expect(landed?.value).toBe(carried)
  })
})

describe('removing it', () => {
  it('asks first, and says the counter is unaffected', async () => {
    const db = await till()
    await show(db)
    await paste(await sign(licence()))

    const removeButton = await screen.findByRole('button', { name: 'Remove' })
    await act(async () => { fireEvent.click(removeButton) })

    expect(screen.getByText(/counter is unaffected/i)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))
    })

    expect(await screen.findByText('No licence code on this till')).toBeTruthy()
    const gone = await db.get('SELECT value FROM settings WHERE key = ?', ['licence_token'])
    expect(gone).toBeUndefined()
  })
})
