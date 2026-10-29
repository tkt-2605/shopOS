import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The main till's upload of the online shop to Cloudflare (`core/cloudShop.ts`).
 *
 * What matters: a change goes up, nothing goes up twice, a photo is never named
 * in an uploaded list before the photo itself is there, and a failed upload is
 * tried again rather than marked done.
 */

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const deviceSettings = new Map<string, string>()
vi.mock('../src/core/device', () => ({
  deviceSetting: (key: string) => deviceSettings.get(key) ?? null,
  setDeviceSetting: async (key: string, value: string | null) => {
    if (value === null || value === '') deviceSettings.delete(key)
    else deviceSettings.set(key, value)
    return true
  },
}))
vi.mock('../src/core/log', () => ({ logEvent: () => undefined, describe: (e: unknown) => String(e) }))

let status = { state: 'open', shop: 'TRT' }
let catalog = { hash: 'h1', since: 's', itemCount: 1, body: JSON.stringify({ items: [{ photo: 'p1', thumb: 't1' }] }) }
vi.mock('@shopos/core/web', () => ({
  publicStatus: async () => status,
  currentCatalog: async () => catalog,
}))

const { pushShop } = await import('../src/core/cloudShop')
const db = {} as never

/** What reached Cloudflare, in order: `status`, `catalog`, `img-<hash>`. */
let sent: string[]
let failPhoto: string | null

beforeEach(() => {
  deviceSettings.clear()
  sent = []
  failPhoto = null
  status = { state: 'open', shop: 'TRT' }
  catalog = { hash: 'h1', since: 's', itemCount: 1, body: JSON.stringify({ items: [{ photo: 'p1', thumb: 't1' }] }) }
  invoke.mockReset()
  invoke.mockImplementation(async (cmd: string, args: { key?: string; hash?: string; text?: string }) => {
    if (cmd === 'cloud_ready') return true
    if (cmd === 'cloud_put_text') { sent.push(args.key!); return null }
    if (cmd === 'cloud_put_photo') {
      if (args.hash === failPhoto) throw new Error('line down')
      sent.push(`img-${args.hash}`)
      return true
    }
    throw new Error(`unexpected ${cmd}`)
  })
})

describe('uploading the online shop', () => {
  it('sends the status, the photos, then the list that names them', async () => {
    await pushShop(db)
    expect(sent[0]).toBe('status')
    expect(sent.slice(1, 3).sort()).toEqual(['img-p1', 'img-t1'])
    expect(sent[3]).toBe('catalog')
  })

  it('sends nothing the second time when nothing changed', async () => {
    await pushShop(db)
    sent = []
    await pushShop(db)
    expect(sent).toEqual([])
  })

  it('sends only the status when only a setting on it changed', async () => {
    await pushShop(db)
    sent = []
    status = { ...status, state: 'closed' }
    await pushShop(db)
    expect(sent).toEqual(['status'])
  })

  it('sends a changed list, and only the photos it has not sent before', async () => {
    await pushShop(db)
    sent = []
    catalog = { ...catalog, hash: 'h2', body: JSON.stringify({ items: [{ photo: 'p1', thumb: 't1' }, { photo: 'p2', thumb: null }] }) }
    await pushShop(db)
    expect(sent).toEqual(['img-p2', 'catalog'])
  })

  it('does not upload a list whose photo failed, and tries the whole thing again next time', async () => {
    failPhoto = 't1'
    await pushShop(db)
    expect(sent).not.toContain('catalog')
    failPhoto = null
    sent = []
    await pushShop(db)
    expect(sent).toContain('img-t1')
    expect(sent.at(-1)).toBe('catalog')
  })

  it('uploads nothing at all on a computer with no Cloudflare key', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'cloud_ready' ? false : (sent.push(cmd), null)))
    await pushShop(db)
    expect(sent).toEqual([])
  })

  it('folds calls that arrive while one runs into one more pass, not a pile', async () => {
    await Promise.all([pushShop(db), pushShop(db), pushShop(db)])
    expect(sent.filter((k) => k === 'catalog')).toHaveLength(1)
  })
})
