import { beforeEach, describe, expect, it, vi } from 'vitest'

/* functions/data/[[path]].js: what Cloudflare serves from the shop's uploaded copy, till on or off. */

type Handler = (ctx: unknown) => Promise<Response>
const load = async (): Promise<Handler> =>
  ((await import('../functions/data/[[path]].js' as string)) as { onRequestGet: Handler }).onRequestGet

const HASH = 'd'.repeat(64)
const PHOTO = 'e'.repeat(64)
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

function kv(values: Record<string, string | Uint8Array>) {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const v = values[key]
      if (v === undefined) return null
      if (type === 'json') return JSON.parse(v as string)
      if (type === 'arrayBuffer') return (v as Uint8Array).buffer
      return v
    }),
  }
}

const stored = {
  status: JSON.stringify({ state: 'open', shop: 'TRT' }),
  catalog: JSON.stringify({ hash: HASH, since: '2026-10-29T00:00:00Z', items: 20, body: '{"shop":"TRT","items":[]}' }),
  [`img-${PHOTO}`]: WEBP,
}

let cache: Map<string, Response>
beforeEach(() => {
  cache = new Map()
  vi.stubGlobal('caches', {
    default: {
      match: async (r: Request) => cache.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => { cache.set(r.url, res) },
    },
  })
})

async function get(path: string, values: Record<string, string | Uint8Array> = stored) {
  const onRequestGet = await load()
  const waits: Promise<unknown>[] = []
  const res = await onRequestGet({
    request: new Request(`https://shop.test/data/${path}`),
    env: { SHOP: kv(values) },
    params: { path: path.split('/') },
    waitUntil: (p: Promise<unknown>) => { waits.push(p) },
  })
  await Promise.all(waits)
  return res
}

describe('the shop served from Cloudflare', () => {
  it('gives the status as the till uploaded it, briefly cached', async () => {
    const res = await get('status.json')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: 'open', shop: 'TRT' })
    expect(res.headers.get('cache-control')).toBe('public, max-age=10')
  })

  it('gives the manifest without the list in it', async () => {
    expect(await (await get('manifest.json')).json()).toEqual({ hash: HASH, since: '2026-10-29T00:00:00Z', items: 20 })
  })

  it('gives the list by its own name, for ever', async () => {
    const res = await get(`catalog/${HASH}.json`)
    expect(await res.text()).toBe('{"shop":"TRT","items":[]}')
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('does not hand out an old list under a name it no longer has', async () => {
    expect((await get(`catalog/${'0'.repeat(64)}.json`)).status).toBe(404)
  })

  it('gives a photo with its right type', async () => {
    const res = await get(`img/${PHOTO}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
  })

  it('says not found, uncached, before the till has uploaded anything', async () => {
    for (const path of ['status.json', 'manifest.json', `img/${PHOTO}`]) {
      const res = await get(path, {})
      expect(res.status).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(cache.size).toBe(0)
  })

  it('refuses anything that is not one of its four kinds of thing', async () => {
    for (const path of ['', 'orders.json', 'img/not-a-hash', 'catalog/x.json', `img/${PHOTO}/../status.json`]) {
      expect((await get(path)).status).toBe(404)
    }
  })

  it('answers a second ask from the edge cache, without the store', async () => {
    await get('status.json')
    const onRequestGet = await load()
    const store = kv({})
    const res = await onRequestGet({
      request: new Request('https://shop.test/data/status.json'), env: { SHOP: store }, params: { path: ['status.json'] }, waitUntil: () => {},
    })
    expect(res.status).toBe(200)
    expect(store.get).not.toHaveBeenCalled()
  })
})
