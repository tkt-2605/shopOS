import { invoke } from '@tauri-apps/api/core'
import { Backup, backupDatabase, type BackupFile } from '@shopos/core'

export type { BackupFile }

export async function listBackups(): Promise<BackupFile[]> {
  try {
    return Backup.sortBackups(await invoke<BackupFile[]>('backup_list'))
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

export async function takeBackup(name: string): Promise<string> {
  const target = await backupPath(name)
  await backupDatabase(invoke, target)
  return target
}

export interface DailyResult {
  created: string | null
  pruned: string[]
  error: string | null
}

/**
 * Runs at startup, not on a timer: a shop machine is switched on in the morning
 * and off at night, so "once a day" and "once per opening" are the same thing,
 * and nothing has to survive the app being closed.
 */
export async function runDailyBackup(now = new Date()): Promise<DailyResult> {
  const plan = Backup.planBackup(await listBackups(), now)
  if (!plan.create) return { created: null, pruned: [], error: null }

  try {
    await takeBackup(plan.create)
  } catch (err) {
    return { created: null, pruned: [], error: typeof err === 'string' ? err : 'Backup failed.' }
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

  return { created: plan.create, pruned, error: null }
}
