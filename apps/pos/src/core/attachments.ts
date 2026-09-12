import { invoke } from '@tauri-apps/api/core'
import type { StoredFile } from '@shopos/core'

/**
 * Getting a photograph from the counter onto the disk.
 *
 * The bytes go to Rust as base64 and come back described by their own hash; the
 * row that points at them is written by the core afterwards. The webview never
 * learns where the file went beyond the relative path, and never opens a file
 * itself — same shape as printing, exports and backup.
 */

export interface StoredResult extends StoredFile {
  /** The bytes were already on disk under another document. */
  existed: boolean
}

/**
 * Base64 in chunks. `String.fromCharCode(...bytes)` on a two-megabyte
 * photograph blows the argument limit and throws, which is a bug that only
 * shows up on a real phone picture.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export async function storeFile(file: File | Blob, fileName: string): Promise<StoredResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return invoke<StoredResult>('attachment_store', { data: toBase64(bytes), fileName })
}

/** A `data:` URL, because the asset protocol is off and the CSP allows data:. */
export async function readFile(storedPath: string): Promise<string> {
  return invoke<string>('attachment_read', { path: storedPath })
}

export async function deleteFile(storedPath: string): Promise<void> {
  await invoke('attachment_delete', { path: storedPath })
}

export async function filePresent(storedPath: string): Promise<boolean> {
  try {
    return await invoke<boolean>('attachment_present', { path: storedPath })
  } catch {
    return false
  }
}

/**
 * What a paste or a drop actually carried.
 *
 * A screenshot pasted from the clipboard arrives with no name at all, which is
 * the commonest case this feature exists for — one Ctrl+V after a UPI payment.
 */
export function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  if (out.length === 0) out.push(...Array.from(data.files ?? []))
  return out
}

export function nameFor(file: File, at = new Date()): string {
  if (file.name && file.name !== 'image.png') return file.name
  const stamp = at.toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const ext = file.type.split('/')[1] ?? 'png'
  return `pasted-${stamp}.${ext}`
}
