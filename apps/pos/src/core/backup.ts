import { invoke } from '@tauri-apps/api/core'
import {
  Backup, backupDatabase, attachmentsToCarry, CARRY_WINDOW_DAYS, getSetting,
  type BackupFile, type BackupEntry, type SqlDriver,
} from '@shopos/core'

export type { BackupFile, BackupEntry }

/**
 * Archives, not bare database files.
 *
 * A `.zip` holds the database and — once they exist — the photographs attached to
 * bills and stock entries, so there is one file to carry off the machine and no
 * way to take the ledger without its evidence. Shops upgrading from v1 keep a
 * folder of `.db` files, which stay listable, prunable and restorable.
 */
const FORMAT = 'zip' as const

export async function listBackups(): Promise<BackupFile[]> {
  try {
    return Backup.sortBackups(await invoke<BackupFile[]>('backup_list'))
  } catch {
    return []
  }
}

export async function describeBackups(): Promise<BackupEntry[]> {
  try {
    return Backup.describeBackups(await invoke<BackupFile[]>('backup_list'))
  } catch {
    return []
  }
}

export async function backupPath(name: string): Promise<string> {
  return invoke<string>('backup_path', { name })
}

export async function deleteBackup(name: string): Promise<void> {
  await invoke('backup_delete', { name })
}

export async function chooseFolder(): Promise<string | null> {
  try {
    return (await invoke<string | null>('choose_folder')) ?? null
  } catch {
    return null
  }
}

export type CopyResult = { ok: true; path: string } | { ok: false; message: string }

export async function copyBackup(name: string, destination: string): Promise<CopyResult> {
  try {
    return { ok: true, path: await invoke<string>('backup_copy', { name, destination }) }
  } catch (err) {
    return { ok: false, message: typeof err === 'string' ? err : 'The copy did not complete.' }
  }
}

export async function takeBackup(
  name: string,
  now = new Date(),
  attachments: string[] = [],
): Promise<void> {
  if (name.endsWith('.zip')) {
    await invoke('backup_write_zip', { name, now: now.toISOString(), attachments })
    return
  }
  // A caller can still ask for the bare v1 format; nothing in the app does.
  await backupDatabase(invoke, await backupPath(name))
}

/** The setting holding the command to run after a backup. Empty means none. */
export const HOOK_SETTING = 'backup_hook'

export interface HookResult {
  ok: boolean
  code: number | null
  output: string
}

export async function runHook(command: string, name: string): Promise<HookResult> {
  return invoke<HookResult>('run_backup_hook', { command, name })
}

/**
 * What cannot be reconstructed is in every archive in full; photographs are
 * carried for the recent window only, and the older ones stay on disk under the
 * attachments folder.
 */
async function carryList(db: SqlDriver, now: Date): Promise<string[]> {
  try {
    return (await attachmentsToCarry(db, now, CARRY_WINDOW_DAYS)).map((a) => a.storedPath)
  } catch {
    // A backup of the ledger is worth taking even if the photograph list fails.
    return []
  }
}

/**
 * Takes one backup and, if the shop has configured one, hands it to the command
 * that carries it off the machine.
 *
 * The hook is fired and not waited for: an upload takes as long as the shop's
 * connection takes, and neither the counter nor this screen may wait on it.
 */
export async function takeBackupNow(
  db: SqlDriver,
  name: string,
  now = new Date(),
): Promise<{ attachments: number }> {
  const carry = await carryList(db, now)
  await takeBackup(name, now, carry)

  const command = (await getSetting(db, HOOK_SETTING))?.trim()
  if (command) void runHook(command, name).catch(() => undefined)

  return { attachments: carry.length }
}

export interface DailyResult {
  created: string | null
  pruned: string[]
  /** How many photographs the archive carries, for saying so on the screen. */
  attachments: number
  error: string | null
}

/**
 * Runs at startup, not on a timer: a shop machine is switched on in the morning
 * and off at night, so "once a day" and "once per opening" are the same thing,
 * and nothing has to survive the app being closed.
 */
export async function runDailyBackup(db: SqlDriver, now = new Date()): Promise<DailyResult> {
  const plan = Backup.planBackup(await listBackups(), now, Backup.KEEP_DAILY, FORMAT)
  if (!plan.create) return { created: null, pruned: [], attachments: 0, error: null }

  let carried = 0
  try {
    carried = (await takeBackupNow(db, plan.create, now)).attachments
  } catch (err) {
    return {
      created: null, pruned: [], attachments: 0,
      error: typeof err === 'string' ? err : 'Backup failed.',
    }
  }

  // Only after the new copy is safely written.
  const pruned: string[] = []
  for (const name of plan.prune) {
    try {
      await deleteBackup(name)
      pruned.push(name)
    } catch {
      // An old backup that will not delete is not worth interrupting the shop for.
    }
  }

  return { created: plan.create, pruned, attachments: carried, error: null }
}

export function todaysBackupName(now = new Date()): string {
  return Backup.backupFileName(now, FORMAT)
}
