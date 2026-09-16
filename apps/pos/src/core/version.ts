import { invoke } from '@tauri-apps/api/core'

/**
 * What is running, asked of the thing that is running it.
 *
 * Rust answers, not `package.json`: `src-tauri/src/version.rs` carries why.
 * The webview's own build-time constant is a claim about the repository at the
 * moment the bundle was made, and the question being asked — down a phone line,
 * by whoever is trying to work out why one shop behaves differently from
 * another — is about the binary on that machine.
 */
export interface AppVersion {
  version: string
  /** The migration the database has been brought up to, or null if unreadable. */
  schema: number | null
}

export async function appVersion(): Promise<AppVersion | null> {
  try {
    return await invoke<AppVersion>('app_version')
  } catch {
    // Shown on `CouldNotStart` too, where a good deal is already broken. A
    // version line that throws must not be the thing that takes the last
    // working screen down with it.
    return null
  }
}

/** `0.1.0 · schema 27`, or as much of it as could be established. */
export function versionLine(v: AppVersion | null): string {
  if (!v) return 'version unknown'
  return `${v.version} · schema ${v.schema ?? 'unknown'}`
}
