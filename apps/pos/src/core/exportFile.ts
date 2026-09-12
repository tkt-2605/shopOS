import { invoke } from '@tauri-apps/api/core'

export type SaveResult = { ok: true; path: string } | { ok: false; message: string }

/**
 * The webview sandbox blocks a download link, so a report is written by the Rust
 * side into one folder under Documents and the caller shows where it landed.
 */
export async function saveFile(filename: string, contents: string): Promise<SaveResult> {
  try {
    const path = await invoke<string>('export_file', { filename, contents })
    return { ok: true, path }
  } catch (err) {
    return { ok: false, message: typeof err === 'string' ? err : 'The file could not be saved.' }
  }
}
