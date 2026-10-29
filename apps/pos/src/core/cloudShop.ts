import { invoke } from '@tauri-apps/api/core'
import type { SqlDriver } from '@shopos/core'
import { currentCatalog, publicStatus } from '@shopos/core/web'
import { deviceSetting, setDeviceSetting } from './device'
import { logEvent, describe } from './log'

/**
 * The online shop's public side, uploaded to Cloudflare by the main till so
 * the storefront has it when the till is off (`src-tauri/src/cloud.rs`).
 *
 * Three things, each sent only when it changed:
 *   - `status`: open or closed, the shop's name, contact, WhatsApp, offers --
 *     `publicStatus`, the very object the till answers live;
 *   - `catalog`: the item list as the till would serve it, with its hash;
 *   - `img-<hash>`: each photo the list names, once ever.
 *
 * Called when the till starts answering the storefront, after any change in
 * Settings, Online orders, and every few minutes for what changes on its own
 * (stock, prices). Cloudflare's free plan allows 1,000 writes a day; a write
 * only when something changed, at most every three minutes, stays far inside.
 * A failed upload is tried again next time; the phones keep what they had.
 */

const EVERY_MS = 3 * 60 * 1000
const PHOTOS_KEY = 'cloud_photos'
const CATALOG_KEY = 'cloud_catalog'

let sentStatus: string | null = null
let running: Promise<void> | null = null
let again = false
let timer: ReturnType<typeof setInterval> | null = null

export async function cloudReady(): Promise<boolean> {
  return invoke<boolean>('cloud_ready').catch(() => false)
}

/** Uploads whatever changed. Calls that arrive while one runs are folded into one more pass. */
export function pushShop(db: SqlDriver): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await pushOnce(db).catch((err) => logEvent('warn', 'web', `upload to Cloudflare failed: ${describe(err)}`))
    } while (again)
  })().finally(() => { running = null })
  return running
}

export function keepShopUploaded(db: SqlDriver): void {
  if (timer) return
  void pushShop(db)
  timer = setInterval(() => { void pushShop(db) }, EVERY_MS)
}

export function stopUploading(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function pushOnce(db: SqlDriver): Promise<void> {
  if (!await cloudReady()) return

  const status = JSON.stringify(await publicStatus(db))
  if (status !== sentStatus) {
    await invoke('cloud_put_text', { key: 'status', text: JSON.stringify({ ...JSON.parse(status), at: new Date().toISOString() }) })
    sentStatus = status
  }

  const catalog = await currentCatalog(db, new Date())
  if (catalog.hash === deviceSetting(CATALOG_KEY)) return

  /* Photos first, so no phone is ever handed a list naming a photo that is not there yet. */
  const sent = new Set<string>(JSON.parse(deviceSetting(PHOTOS_KEY) ?? '[]') as string[])
  const items = (JSON.parse(catalog.body) as { items: { photo: string | null; thumb: string | null }[] }).items
  const wanted = [...new Set(items.flatMap((i) => [i.photo, i.thumb]).filter((h): h is string => h !== null))]
  for (const hash of wanted.filter((h) => !sent.has(h))) {
    if (await invoke<boolean>('cloud_put_photo', { hash })) sent.add(hash)
  }
  await setDeviceSetting(PHOTOS_KEY, JSON.stringify([...sent].filter((h) => wanted.includes(h))))

  await invoke('cloud_put_text', {
    key: 'catalog',
    text: JSON.stringify({ hash: catalog.hash, since: catalog.since, items: catalog.itemCount, body: catalog.body }),
  })
  await setDeviceSetting(CATALOG_KEY, catalog.hash)
  logEvent('info', 'web', `uploaded the online shop to Cloudflare (${catalog.itemCount} items)`)
}
