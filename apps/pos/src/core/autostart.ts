import { invoke } from '@tauri-apps/api/core'

/**
 * "Start this till with Windows" (`src-tauri/src/autostart.rs`): on, Windows
 * opens this till when somebody signs in, and the main till then opens the
 * storefront and its tunnel by itself. False when it cannot be told.
 */
export async function startsWithWindows(): Promise<boolean> {
  return invoke<boolean>('autostart_get').catch(() => false)
}

/** Says what it is now, which is what the switch should show. */
export async function setStartsWithWindows(on: boolean): Promise<boolean> {
  return invoke<boolean>('autostart_set', { on })
}
