import { invoke } from '@tauri-apps/api/core'
import { deviceSetting, setDeviceSetting } from './device'
import { logEvent } from './log'
import {
  Backup, attachmentsToCarry, CARRY_WINDOW_DAYS,
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

/**
 * An unreadable backup folder is not an empty one.
 *
 * These two used to answer `[]` for both, and the two look identical on the
 * screen: "No backups yet." A shop whose backup folder had been renamed,
 * moved onto a USB stick that is no longer in the machine, or locked by the
 * sync client that was meant to be carrying it offsite read that line every
 * morning as reassurance that nothing had happened yet — while in fact nothing
 * was being kept at all. So the failure is thrown, and the three callers say
 * which folder could not be read.
 */
export async function listBackups(): Promise<BackupFile[]> {
  return Backup.sortBackups(await invoke<BackupFile[]>('backup_list'))
}

export async function describeBackups(): Promise<BackupEntry[]> {
  return Backup.describeBackups(await invoke<BackupFile[]>('backup_list'))
}

/** What to put on a screen when either of the two above threw. */
export function backupFolderProblem(err: unknown): string {
  const detail = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  return `Could not read the backup folder: ${detail}`
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

/**
 * Always an archive. The bare v1 `.db` format went through `backup_database`,
 * which wrote to any path it was handed and which nothing in the app used any
 * more; it is gone from Rust, and `backup_write_zip` refuses any other name
 * with a sentence rather than this module inventing one.
 */
export async function takeBackup(
  name: string,
  now = new Date(),
  attachments: string[] = [],
): Promise<void> {
  await invoke('backup_write_zip', { name, now: now.toISOString(), attachments })
}

/**
 * The command to run after a backup, held on this machine and not in the shop's
 * database.
 *
 * It carries the file to a USB stick, a NAS share or a syncing folder — none of
 * which are the same on the next counter. Shared, two tills would both fire the
 * shop's one command against their own backup, and the last to finish would be
 * the copy that survived.
 */
export const HOOK_SETTING = 'backup_hook'

export interface HookResult {
  ok: boolean
  code: number | null
  output: string
}

/**
 * Runs the carry-off command saved on this machine against one backup.
 *
 * Only the backup's name crosses to Rust. The command itself is read there,
 * from `device.json`, so that `run_backup_hook` cannot be handed an arbitrary
 * shell line by anything that reaches `invoke`.
 */
export async function runHook(name: string): Promise<HookResult> {
  return invoke<HookResult>('run_backup_hook', { name })
}

/**
 * The setting that remembers how the last carry-off went.
 *
 * On this machine and not in the shop's database, for the same reason the
 * command itself is: two tills run two different commands against two different
 * files, and a shared row would show one of them the other's result.
 */
export const LAST_HOOK_SETTING = 'last_hook_result'

export interface HookRun extends HookResult {
  /** When it finished, ISO. */
  at: string
}

const hookWatchers = new Set<(run: HookRun | null) => void>()

/** Subscribe a screen to the result of the next carry-off. Returns unsubscribe. */
export function onHookResult(fn: (run: HookRun | null) => void): () => void {
  hookWatchers.add(fn)
  return () => { hookWatchers.delete(fn) }
}

/** What the last carry-off did, as this machine last recorded it. */
export function lastHookRun(): HookRun | null {
  const raw = deviceSetting(LAST_HOOK_SETTING)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<HookRun>
    if (typeof parsed?.at !== 'string') return null
    return {
      ok: parsed.ok === true,
      code: typeof parsed.code === 'number' ? parsed.code : null,
      output: typeof parsed.output === 'string' ? parsed.output : '',
      at: parsed.at,
    }
  } catch {
    // A setting that will not parse is a setting that says nothing, which is
    // the same as never having run. It is overwritten by the next run.
    return null
  }
}

/**
 * Runs the carry-off command and records what happened to it.
 *
 * The hook is still fired and not waited for — an rclone upload takes as long
 * as the shop's connection takes, and the counter may not wait on it. But
 * "not waited for" had been doing double duty as "not looked at": the result
 * was dropped into an empty `.catch()`, so a command that had been exiting 1
 * every night for a month — wrong remote, expired token, full disk — looked
 * exactly like one that was working. The upload is the *only* copy that
 * survives the machine being stolen or the disk dying, so its failure is the
 * one failure in this file that must not be quiet.
 *
 * Because it finishes long after the screen that started it has moved on, the
 * result is stored rather than returned, and the Backup card reads it back.
 */
export async function recordHookRun(command: string, name: string): Promise<HookRun> {
  let run: HookRun
  try {
    /* Rust runs the command saved in `device.json`, not this string. The
       Settings field saves on blur, and pressing Test is what blurs it — so
       the save may still be in flight. Saving here first means the run is of
       the command the screen is showing, and never of the one before it. */
    const wanted = command.trim()
    if (wanted !== (deviceSetting(HOOK_SETTING) ?? '').trim()
      && !(await setDeviceSetting(HOOK_SETTING, wanted))) {
      throw new Error('The command was not saved on this machine, so it was not run.')
    }
    const result = await runHook(name)
    run = { ...result, at: new Date().toISOString() }
  } catch (err) {
    run = {
      ok: false,
      code: null,
      output: typeof err === 'string' ? err : err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    }
  }

  // A machine that cannot write its own settings file has a louder problem, and
  // `DeviceTroubleBanner` is already saying it. Losing this line to that is fine.
  await setDeviceSetting(LAST_HOOK_SETTING, JSON.stringify(run)).catch(() => false)
  for (const fn of hookWatchers) fn(run)
  return run
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

  const command = deviceSetting(HOOK_SETTING)?.trim()
  if (command) void recordHookRun(command, name)

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
 * Runs at startup **and** on a timer.
 *
 * Once-per-opening was right, and was right for the reason `backup.ts` gave: a
 * shop machine is switched on in the morning and off at night, so "once a day"
 * and "once per opening" are the same thing. What it missed is the shops where
 * they are not — the counter PC that is never switched off, the till left
 * running across a weekend, the machine that only gets restarted when Windows
 * insists. Those took one backup on whatever morning they were last started
 * and then none, for as long as they stayed up, with the Backup card showing a
 * perfectly healthy list that simply stopped growing.
 *
 * So both: this on open, and `startDailyBackupTimer` at 02:00 — an hour when
 * the shutters are down everywhere, and the one moment a VACUUM INTO over the
 * whole database cannot land in the middle of a queue at the counter.
 */
export async function runDailyBackup(db: SqlDriver, now = new Date()): Promise<DailyResult> {
  let existing: BackupFile[]
  try {
    existing = await listBackups()
  } catch (err) {
    // Since `listBackups` stopped answering `[]` for an unreadable folder, this
    // is reachable — and it must not be read as "no backups yet, take one",
    // which would write into a folder nobody can list and prune from a list
    // that is missing rows.
    return { created: null, pruned: [], attachments: 0, error: backupFolderProblem(err) }
  }

  const plan = Backup.planBackup(existing, now, Backup.KEEP_DAILY, FORMAT)
  if (!plan.create) return { created: null, pruned: [], attachments: 0, error: null }

  let carried = 0
  try {
    carried = (await takeBackupNow(db, plan.create, now)).attachments
  } catch (err) {
    const said = typeof err === 'string' ? err : 'Backup failed.'
    /* The card shows this until the next successful run, and then it is gone.
       "It failed every day last week and has worked since Tuesday" is a
       different problem from "it failed this morning", and only the file can
       tell them apart. */
    logEvent('error', 'backup', `${plan.create}: ${said}`)
    return { created: null, pruned: [], attachments: 0, error: said }
  }

  /* The successful ones too, which is what makes the failures readable. A log
     that only records failures cannot answer "when did this last work". */
  logEvent('info', 'backup', `wrote ${plan.create}, ${carried} attachment(s)`)

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

/** 02:00 local. The shutters are down and nobody is mid-bill. */
export const DAILY_BACKUP_HOUR = 2

/**
 * Milliseconds from `now` to the next `hour:00` local time.
 *
 * Local, via `setHours`, and never UTC arithmetic: 02:00 IST is 20:30 the
 * previous day in UTC, and a backup scheduled by UTC hour would fire in the
 * middle of the evening rush.
 */
export function msUntilHour(hour: number, now = new Date()): number {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/**
 * Fires `runDailyBackup` at the next 02:00 and every 02:00 after, for as long
 * as the app is running. Returns the stop.
 *
 * Re-armed with a fresh `setTimeout` after each run rather than a 24 h
 * `setInterval`, because the two disagree the moment the machine's clock is
 * corrected — and a till whose clock was wrong is exactly the till somebody has
 * just been fixing. Recomputing from the current time each round means the next
 * backup is at the next real 02:00, not 24 h after a timestamp that has since
 * been moved.
 */
export function startDailyBackupTimer(
  db: SqlDriver,
  report: (result: DailyResult) => void,
  hour = DAILY_BACKUP_HOUR,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function arm() {
    if (stopped) return
    timer = setTimeout(() => {
      void runDailyBackup(db)
        .then(report)
        .catch((err: unknown) => {
          report({
            created: null, pruned: [], attachments: 0,
            error: typeof err === 'string' ? err : 'Backup failed.',
          })
        })
        .finally(arm)
    }, msUntilHour(hour))
  }

  arm()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
