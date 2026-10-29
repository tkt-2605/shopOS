import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkShop, fetchCatalog, fetchManifest, imageUrl } from '../src/api'

/* Where the storefront reads from: the shop's copy in Cloudflare first, the till for anything live. */

type Answer = { status: number; body: unknown } | 'down'

function network(answers: Record<string, Answer>) {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url)
    const key = Object.keys(answers).find((k) => url.startsWith(k))
    const a = key ? answers[key]! : 'down'
    if (a === 'down') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(a.body), { status: a.status })
  }))
  return asked
}

const STATUS = { state: 'open', shop: 'TRT', googleClientId: null }

afterEach(() => { vi.unstubAllGlobals() })

describe('whether the shop can take an order', () => {
  it('is open when the till answers open', async () => {
    network({ 'https://till.test/api/status': { status: 200, body: STATUS } })
    expect((await checkShop()).state).toBe('open')
  })

  it('asks again when the till was busy for a moment, rather than calling it closed', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1
        ? new Response(JSON.stringify({ error: 'BUSY' }), { status: 503 })
        : new Response(JSON.stringify(STATUS), { status: 200 })
    }))
    expect((await checkShop()).state).toBe('open')
    expect(calls).toBe(2)
  })

  it('is closed when the till answers closed', async () => {
    network({ 'https://till.test/api/status': { status: 200, body: { ...STATUS, state: 'closed' } } })
    expect((await checkShop()).state).toBe('closed')
  })

  it('is closed now, with the shop still known, when the till is off but its copy is in Cloudflare', async () => {
    network({ 'https://shop.test/data/status.json': { status: 200, body: { ...STATUS, about: { phone: '7397086633' } } } })
    const r = await checkShop()
    expect(r.state).toBe('asleep')
    expect(r.status?.about?.phone).toBe('7397086633')
  })

  it('cannot reach the shop when neither answers but the phone is online', async () => {
    network({ '/manifest.webmanifest': { status: 200, body: {} } })
    expect((await checkShop()).state).toBe('unreachable')
  })

  it('is offline when nothing at all answers', async () => {
    network({})
    expect((await checkShop()).state).toBe('offline')
  })

  it('is offline without asking anybody when the phone says so', async () => {
    const asked = network({})
    vi.stubGlobal('navigator', { onLine: false })
    expect((await checkShop()).state).toBe('offline')
    expect(asked).toEqual([])
  })
})

describe('the item list', () => {
  const MANIFEST = { hash: 'a'.repeat(64), since: '2026-10-29T00:00:00Z', items: 3 }

  it('comes from Cloudflare when it is there', async () => {
    const asked = network({ 'https://shop.test/data/manifest.json': { status: 200, body: MANIFEST } })
    expect(await fetchManifest()).toEqual(MANIFEST)
    expect(asked.every((u) => u.startsWith('https://shop.test/data/'))).toBe(true)
  })

  it('comes from the till when Cloudflare has nothing yet', async () => {
    network({
      'https://shop.test/data/manifest.json': { status: 404, body: { error: 'NOT_FOUND' } },
      'https://till.test/catalog/manifest.json': { status: 200, body: MANIFEST },
    })
    expect(await fetchManifest()).toEqual(MANIFEST)
  })

  it('asks past the short-lived copy only when told to', async () => {
    const asked = network({ 'https://shop.test/data/manifest.json': { status: 200, body: MANIFEST } })
    await fetchManifest()
    await fetchManifest(true)
    expect(asked[0]).toBe('https://shop.test/data/manifest.json')
    expect(asked[1]).toMatch(/^https:\/\/shop\.test\/data\/manifest\.json\?at=\d+$/)
  })

  it('fetches the list itself from Cloudflare, else the till', async () => {
    const hash = 'b'.repeat(64)
    network({ [`https://till.test/catalog/${hash}.json`]: { status: 200, body: { shop: 'TRT', categories: [], items: [] } } })
    expect((await fetchCatalog(hash)).shop).toBe('TRT')
  })

  it('shows photos from Cloudflare, so they show with the till off', () => {
    expect(imageUrl('c'.repeat(64))).toBe(`https://shop.test/data/img/${'c'.repeat(64)}`)
  })
})
