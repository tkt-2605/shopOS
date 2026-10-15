import { invoke } from '@tauri-apps/api/core'
import { shortShopId } from '@shopos/core'

/*
 * Reaching the vendor from the counter.
 *
 * The support code is what a shopkeeper reads out, or what arrives at the top
 * of their WhatsApp message: which shop, which counter, which version. The
 * shop part is the short shop id, the same one on every report the shop sends,
 * on its Licence screen and in a release's list of shops -- one name for one
 * shop wherever the vendor looks it up.
 */

export interface SupportCode {
  /** The short shop id, or null before the shop is set up. */
  shop: string | null
  /** The counter's prefix, as on its bill numbers. */
  counter: string | null
  version: string | null
}

export function supportCode(input: {
  shopId: string | null
  counterPrefix: string | null
  version: string | null
}): SupportCode {
  const shop = input.shopId ? shortShopId(input.shopId) : null
  return {
    shop: shop || null,
    counter: input.counterPrefix?.trim() || null,
    version: input.version,
  }
}

/** `0192 f4a1`: two groups of four, which is how a person reads eight characters down a phone. */
export function spokenShop(shop: string): string {
  return shop.length === 8 ? `${shop.slice(0, 4)} ${shop.slice(4)}` : shop
}

/** One line for copying and for the top of a message: `0192f4a1 · FC · 0.3.0`. */
export function supportLine(code: SupportCode): string {
  return [code.shop ?? 'no shop yet', code.counter, code.version].filter(Boolean).join(' · ')
}

/** What the WhatsApp chat opens with, for the shopkeeper to finish. */
export function helpMessage(code: SupportCode): string {
  return `ShopOS help, please.\nSupport code: ${supportLine(code)}\nWhat happened: `
}

export interface SupportContact {
  phone: string | null
  whatsapp: boolean
}

/** Null when even asking failed -- the screen still shows the code, which is what matters most. */
export async function supportContact(): Promise<SupportContact | null> {
  try {
    return await invoke<SupportContact>('support_contact')
  } catch {
    return null
  }
}

export async function openWhatsApp(text: string): Promise<string | null> {
  try {
    await invoke('support_whatsapp', { text })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export type RemoteHelp =
  | { outcome: 'started'; program: string }
  | { outcome: 'notInstalled' }
  | { outcome: 'failed'; error: string }

export async function startRemoteHelp(): Promise<RemoteHelp> {
  try {
    return await invoke<RemoteHelp>('start_remote_help')
  } catch (err) {
    return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
