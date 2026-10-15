import { invoke } from '@tauri-apps/api/core'

/*
 * The shop's data, sent to support at the owner's say-so: made into one
 * encrypted file by Rust (`support_data.rs`), then sent to the portal or
 * saved to a folder. Nothing here sees the data; it asks Rust and says what
 * happened.
 */

export interface Made {
  id: string
  bytes: number
  customersHidden: number
}

export interface Upload {
  done: boolean
  bytes: number
  error: string | null
}

/** Whether this build can seal data to the vendor at all. */
export function supportDataReady(): Promise<boolean> {
  return invoke<boolean>('support_data_ready').catch(() => false)
}

export function makeSupportData(input: {
  shopId: string; madeBy: string; note: string; anonymise: boolean; now?: Date
}): Promise<Made> {
  return invoke<Made>('support_data_make', {
    shopId: input.shopId, madeBy: input.madeBy, note: input.note, anonymise: input.anonymise,
    now: (input.now ?? new Date()).toISOString(),
  })
}

export function sendSupportData(id: string): Promise<Upload> {
  return invoke<Upload>('support_data_send', { id })
}

export function saveSupportData(id: string, folder: string): Promise<string> {
  return invoke<string>('support_data_save', { id, folder })
}

export function discardSupportData(id: string): Promise<void> {
  return invoke<void>('support_data_discard', { id })
}

/** `12.4 MB`, for a person deciding whether to wait. */
export function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`
}
