import { invoke } from '@tauri-apps/api/core'
import { deviceSetting, setDeviceSetting } from './device'
import { logEvent } from './log'
import { appVersion } from './version'
import { FOLDER_SETTING, recordCopyRun } from './backupFolder'
import {
  Backup, attachmentsToCarry, CARRY_WINDOW_DAYS,
  type BackupFile, type BackupEntry, type BackupSchedule, type SqlDriver,
} from '@shopos/core'

export type { BackupFile, BackupEntry }

/**
 * How often this machine backs up, and from when. Held on this machine and not
 * in the shop's database: a till that is switched off at night and one that
 * never is want different answers, and they are the same shop.
 */
export const EVERY_SETTING = 'backup_every'
export const AT_SETTING = 'backup_at'

export function backupSchedule(): BackupSchedule {
  return Backup.parseSchedule(deviceSetting(EVERY_SETTING), deviceSetting(AT_SETTING))
}

/** When the timer will next look, for the screen to say. */
export function nextBackupAt(now = new Date()): Date {
  return Backup.nextSlot(backupSchedule(), now)
}

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
 * Takes one backup and, if this machine has them, hands it to the folder it is
 * copied into and to the command that carries it off.
 *
 * Neither is waited for: a stick can be slow and an upload takes as long as the
 * shop's connection takes, and neither the counter nor this screen may wait.
 */
export async function takeBackupNow(
  db: SqlDriver,
  name: string = Backup.backupStampName(),
  now = new Date(),
): Promise<{ attachments: number }> {
  const carry = await carryList(db, now)
  await takeBackup(name, now, carry)

  if (deviceSetting(FOLDER_SETTING)) void recordCopyRun(name, now)
  const command = deviceSetting(HOOK_SETTING)?.trim()
  if (command) void recordHookRun(command, name)

  return { attachments: carry.length }
}

export interface BackupResult {
  created: string | null
  pruned: string[]
  /** How many photographs the archive carries, for saying so on the screen. */
  attachments: number
  error: string | null
}

/**
 * Takes a backup if one is due by this machine's schedule, and prunes.
 *
 * Once-per-opening was right for a machine switched on in the morning and off
 * at night, and wrong for the counter PC that is never switched off: it took
 * one backup on whatever morning it was last started and then none, with the
 * Backup card showing a healthy list that simply stopped growing. So the timer
 * calls this too, and "due" is decided by the schedule rather than by whether
 * the app was opened.
 */
export async function runScheduledBackup(db: SqlDriver, now = new Date()): Promise<BackupResult> {
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

  const plan = Backup.planBackup(existing, now, backupSchedule())
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

/* ------------------------------------------------ before an upgrade --- */

/**
 * Why the last copy before an upgrade could not be taken, for the top-bar dot
 * and the Backups card. Held for the life of the process: the one before
 * migrating is taken at start, before any screen exists to show it.
 */
let upgradeProblem: string | null = null

export function upgradeCopyFailure(): string | null {
  return upgradeProblem
}

/**
 * Writes a copy of the database before an upgrade touches it, and trims the
 * older ones of the same kind. Answers the reason it failed, or null.
 *
 * Never throws. The owner's decision (`update-rollout.md`, step 8) is that a
 * failed copy warns and never blocks: a shop that cannot back up must still be
 * able to bill, and a migration it cannot take is a till that cannot start.
 */
export async function takeUpgradeCopy(name: string): Promise<string | null> {
  try {
    await invoke('backup_write_safety', { name })
  } catch (err) {
    const said = typeof err === 'string' ? err : err instanceof Error ? err.message : 'the copy was not written'
    upgradeProblem = `The copy before the upgrade (${name}) was not written: ${said}`
    logEvent('error', 'backup', upgradeProblem)
    return said
  }
  upgradeProblem = null
  logEvent('info', 'backup', `wrote ${name}`)
  try {
    for (const old of Backup.pruneUpgradeCopies(await invoke<BackupFile[]>('backup_list'))) {
      await deleteBackup(old).catch(() => undefined)
    }
  } catch {
    // An old copy that will not go is not worth a word to anyone.
  }
  return null
}

/** The copy taken before installing an update over the version running now. */
export async function beforeUpdateCopy(): Promise<string | null> {
  const running = await appVersion()
  return takeUpgradeCopy(Backup.beforeUpdateName(running?.version ?? '0.0.0'))
}

/** 02:00 local. The shutters are down and nobody is mid-bill. The stock replay keeps it. */
export const DAILY_BACKUP_HOUR = 2

/**
 * Milliseconds from `now` to the next `hour:00` local time.
 *
 * Local, via `setHours`, and never UTC arithmetic: 02:00 IST is 20:30 the
 * previous day in UTC, and a job scheduled by UTC hour would fire in the
 * middle of the evening rush.
 */
export function msUntilHour(hour: number, now = new Date()): number {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/** How often the timer looks at the clock. */
export const TICK_MS = 60_000

/** How long after a failed backup the timer tries again. */
export const RETRY_MS = 10 * 60_000

/**
 * The one failure that is not a failure: a bill was being saved at that
 * second. `vacuum_into` refuses rather than copy half a transaction, and the
 * right answer is the next minute, not a red dot in the top bar.
 */
const MID_BILL = /transaction is open/

/**
 * Looks at the clock now and every minute after, and backs up whenever the
 * schedule's latest slot has changed since it last looked. Returns the stop.
 *
 * A tick rather than a timeout aimed at the next slot. The schedule can be
 * changed from Settings at any minute, a laptop till sleeps through the slot
 * it was aimed at, and a clock that is corrected moves every slot at once;
 * a tick that asks "which slot is it now" gets all three right without being
 * told about any of them. "Changed" rather than "later" for the clock: a
 * clock wound back a day must look again, not wait until it catches up.
 *
 * The first look is immediate, and is the backup taken when the shop opens.
 * After the counter is usable, never in front of it -- the caller starts this
 * once the till is ready.
 */
export function startBackupTimer(
  db: SqlDriver,
  report: (result: BackupResult) => void,
): () => void {
  let handled: number | null = null
  let retryAt = 0
  let running = false
  let stopped = false

  function look() {
    if (running || stopped) return
    const now = new Date()
    const slot = Backup.lastSlot(backupSchedule(), now).getTime()
    if (slot === handled || now.getTime() < retryAt) return

    running = true
    void runScheduledBackup(db, now)
      .catch((err: unknown): BackupResult => ({
        created: null, pruned: [], attachments: 0,
        error: typeof err === 'string' ? err : 'Backup failed.',
      }))
      .then((result) => {
        if (stopped) return
        if (result.error && MID_BILL.test(result.error)) return
        report(result)
        if (result.error) retryAt = now.getTime() + RETRY_MS
        else handled = slot
      })
      .finally(() => { running = false })
  }

  look()
  const timer = setInterval(look, TICK_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
