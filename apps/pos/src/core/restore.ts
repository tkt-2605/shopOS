import { invoke } from '@tauri-apps/api/core'
import { Backup } from '@shopos/core'
import { SCHEMA_VERSION } from './migrations'

/**
 * The webview's half of restore.
 *
 * Nothing here replaces anything. `begin` validates, parks a copy of the current
 * data and stages the replacement, then the app restarts and the swap happens
 * before the database is opened. The schema version this build understands is
 * passed down rather than read in Rust, because the migrations are the
 * TypeScript side's to count.
 */

export interface RestoreCheck {
  name: string
  format: 'db' | 'zip'
  bytes: number
  schema: number
  supported: number
  ok: boolean
  problem: string | null
  warning: string | null
  taken_at: string | null
}

export interface RestoreMarker {
  source: string
  safety: string
  staged_at: string
}

export interface RestoreReport {
  restored: RestoreMarker | null
  error: string | null
}

export async function inspectBackup(name: string): Promise<RestoreCheck | { failed: string }> {
  try {
    return await invoke<RestoreCheck>('restore_inspect', { name, supported: SCHEMA_VERSION })
  } catch (err) {
    return { failed: typeof err === 'string' ? err : 'That backup could not be read.' }
  }
}

/**
 * Does not return: the app restarts to apply what this stages. Anything it
 * rejects it rejects before the copy of the current data is taken, so a refusal
 * leaves the shop exactly as it was.
 */
export async function beginRestore(name: string, now = new Date()): Promise<string | null> {
  try {
    await invoke('restore_begin', {
      name,
      safetyName: Backup.safetyName(now),
      now: now.toISOString(),
      supported: SCHEMA_VERSION,
    })
    return null
  } catch (err) {
    return typeof err === 'string' ? err : 'The restore could not be started.'
  }
}

/** What the app found and did while starting. Empty on an ordinary start. */
export async function lastRestore(): Promise<RestoreReport> {
  try {
    return await invoke<RestoreReport>('restore_report')
  } catch {
    return { restored: null, error: null }
  }
}

/** Throws away a staged restore that has not been applied. */
export async function abandonRestore(): Promise<void> {
  await invoke('restore_abandon').catch(() => undefined)
}
