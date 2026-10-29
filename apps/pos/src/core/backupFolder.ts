import { invoke } from '@tauri-apps/api/core'
import { Backup, type BackupFile } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from './device'
import { logEvent } from './log'

/**
 * The folder every backup is copied into once it is written: a USB stick, or a
 * folder the Google Drive or OneDrive app carries off the machine. On this
 * machine, for the reason `HOOK_SETTING` in `backup.ts` gives.
 */
export const FOLDER_SETTING = 'backup_folder'
export const LAST_COPY_SETTING = 'last_copy_result'

export interface CopyRun {
  ok: boolean
  /** Where the file went, or why it did not. */
  output: string
  /** When it finished, ISO. */
  at: string
}

const copyWatchers = new Set<(run: CopyRun | null) => void>()

/** Subscribe a screen to the result of the next copy. Returns unsubscribe. */
export function onCopyResult(fn: (run: CopyRun | null) => void): () => void {
  copyWatchers.add(fn)
  return () => { copyWatchers.delete(fn) }
}

/** What the last copy did, as this machine last recorded it. */
export function lastCopyRun(): CopyRun | null {
  const raw = deviceSetting(LAST_COPY_SETTING)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CopyRun>
    if (typeof parsed?.at !== 'string') return null
    return { ok: parsed.ok === true, output: typeof parsed.output === 'string' ? parsed.output : '', at: parsed.at }
  } catch {
    return null
  }
}

/** Forgets the last copy's result, for when the folder changes and it no longer says anything. */
export async function forgetCopyRun(): Promise<void> {
  await setDeviceSetting(LAST_COPY_SETTING, null).catch(() => false)
  for (const fn of copyWatchers) fn(null)
}

/**
 * Copies one backup into the chosen folder, prunes the copies there by the
 * same rule as the ones here, and records how it went.
 *
 * Rust reads the folder from `device.json`; only the backup's name crosses.
 * Recorded rather than returned for the reason `recordHookRun` gives: this is
 * the only copy that survives the machine, and it finishes on nobody's screen.
 * A pruning failure is not a copy failure -- the copy is there -- so it is not
 * what the record says.
 */
export async function recordCopyRun(name: string, now = new Date()): Promise<CopyRun> {
  let run: CopyRun
  try {
    const path = await invoke<string>('backup_copy_out', { name })
    run = { ok: true, output: path, at: new Date().toISOString() }
    try {
      const there = await invoke<BackupFile[]>('backup_folder_list')
      for (const old of Backup.planBackup(there, now).prune) {
        await invoke('backup_folder_delete', { name: old }).catch(() => undefined)
      }
    } catch {
      // The copy is there. An old one that stays is the Drive filling a day later.
    }
  } catch (err) {
    run = {
      ok: false,
      output: typeof err === 'string' ? err : err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    }
    logEvent('error', 'backup', `copying ${name} out: ${run.output}`)
  }
  await setDeviceSetting(LAST_COPY_SETTING, JSON.stringify(run)).catch(() => false)
  for (const fn of copyWatchers) fn(run)
  return run
}

/** A Google Drive or OneDrive folder found on this machine. */
export interface CloudFolder {
  label: string
  root: string
  /** The folder of its own that backups go into. */
  target: string
}

export async function cloudFolders(): Promise<CloudFolder[]> {
  try {
    return await invoke<CloudFolder[]>('cloud_folders')
  } catch {
    return []
  }
}

/** Creates the backups folder inside a found Drive folder and answers its path. */
export async function makeCloudFolder(root: string): Promise<string> {
  return invoke<string>('make_cloud_folder', { root })
}

/**
 * Whether the chosen folder takes backups off this computer -- another drive,
 * or a Drive, OneDrive or Dropbox folder -- or null when none is chosen or
 * Rust could not say (`backup_folder_leaves_machine`).
 */
export async function backupFolderLeavesMachine(): Promise<boolean | null> {
  return invoke<boolean | null>('backup_folder_leaves_machine').catch(() => null)
}
