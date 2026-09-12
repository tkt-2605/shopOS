import { businessDate } from '../dates.js'

/**
 * When to take a backup and which ones to throw away.
 *
 * Deciding is separated from doing on purpose: the decision is the part that can
 * silently be wrong — keeping none, keeping everything until the disk fills, or
 * deleting the only copy — and it is the part worth testing. The copying itself
 * is a single VACUUM INTO on the other side of the boundary.
 */

export const KEEP_DAILY = 14

/** What a backup is written as. `.db` is the v1 format; `.zip` carries the attachments too. */
export type BackupFormat = 'db' | 'zip'

export interface BackupFile {
  name: string
  /** Bytes. Shown to the shopkeeper so an empty backup is visible as one. */
  size: number
}

/**
 * Both extensions are recognised, because an upgraded shop has a folder of `.db`
 * files it must still be able to list, prune and restore. Nothing else matches:
 * the Rust side takes this as its allow-list, and relaxing it to any extension
 * would let the webview name `shop.db-wal`.
 */
const NAME = /^shop-(\d{4}-\d{2}-\d{2})\.(db|zip)$/

/**
 * The copy taken immediately before a restore, so an owner who restores the
 * wrong file has somewhere to go back to.
 *
 * A different shape from a daily backup on purpose. These are not part of the
 * rotation and are never pruned: there are only ever a handful, and the one
 * thing worse than an old restore point is no restore point.
 */
const SAFETY = /^before-restore-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.db$/

export function backupName(when: Date = new Date()): string {
  return `shop-${businessDate(when)}.db`
}

export function backupZipName(when: Date = new Date()): string {
  return `shop-${businessDate(when)}.zip`
}

export function backupFileName(when: Date, format: BackupFormat): string {
  return format === 'zip' ? backupZipName(when) : backupName(when)
}

export function safetyName(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `before-restore-${businessDate(when)}-${pad(when.getHours())}${pad(when.getMinutes())}.db`
}

export function backupDate(name: string): string | null {
  return NAME.exec(name)?.[1] ?? null
}

export function backupExt(name: string): BackupFormat | null {
  const ext = NAME.exec(name)?.[2]
  return ext === 'db' || ext === 'zip' ? ext : null
}

export type BackupKind = 'daily' | 'safety'

export interface BackupEntry extends BackupFile {
  date: string
  /** `HH:MM` for a safety copy; a daily backup is only ever one a day. */
  time: string | null
  kind: BackupKind
  format: BackupFormat
}

/**
 * Everything in the backups folder that ShopOS wrote, newest first, with the
 * safety copies alongside the daily ones — an owner looking for the state from
 * before a restore needs to find it in the same list.
 */
export function describeBackups(files: BackupFile[]): BackupEntry[] {
  const entries: BackupEntry[] = []
  for (const f of files) {
    const daily = NAME.exec(f.name)
    if (daily) {
      entries.push({ ...f, date: daily[1]!, time: null, kind: 'daily', format: daily[2] as BackupFormat })
      continue
    }
    const safety = SAFETY.exec(f.name)
    if (safety) {
      entries.push({
        ...f,
        date: safety[1]!,
        time: `${safety[2]}:${safety[3]}`,
        kind: 'safety',
        format: 'db',
      })
    }
  }
  // Newest first throughout, which puts a safety copy above the same day's
  // backup: the rotation is taken when the shop opens and a restore happens
  // later, so the safety copy really is the more recent state.
  return entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    const at = a.time ?? ''
    const bt = b.time ?? ''
    return at === bt ? 0 : at < bt ? 1 : -1
  })
}

export interface BackupPlan {
  /** The file to write, or null when today's is already on disk. */
  create: string | null
  /** Files to remove once the new one exists. */
  prune: string[]
}

interface Dated {
  name: string
  date: string
  ext: BackupFormat
}

/**
 * One backup a day, keeping the most recent `keep` days.
 *
 * Counted in days rather than in files, because a folder can hold two files for
 * one date during the upgrade from `.db` to `.zip`, and counting files there
 * would quietly keep a week instead of a fortnight.
 *
 * Pruning is deliberately computed as if the new backup already existed, so the
 * count never dips below `keep` in the window between writing and deleting.
 */
export function planBackup(
  existing: BackupFile[],
  when: Date = new Date(),
  keep: number = KEEP_DAILY,
  format: BackupFormat = 'db',
): BackupPlan {
  const today = businessDate(when)
  const dated = existing
    .map((f) => ({ name: f.name, date: backupDate(f.name), ext: backupExt(f.name) }))
    .filter((f): f is Dated => f.date !== null && f.ext !== null)

  // Keyed on the date, not the filename: on the day a shop upgrades, today's
  // `.db` already stands for today and a `.zip` beside it would be a second
  // backup of the same morning.
  const alreadyToday = dated.some((f) => f.date === today)

  const dates = new Set(dated.map((f) => f.date))
  if (!alreadyToday) dates.add(today)

  // Newest first, so the tail is what falls off the end.
  const ordered = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const kept = new Set(ordered.slice(0, Math.max(1, keep)))

  const prune = dated
    .filter((f) => {
      if (!kept.has(f.date)) return true
      // A kept day holding both formats keeps the zip: the zip is a superset of
      // the db, so the db is duplication rather than a second copy.
      return f.ext === 'db' && dated.some((o) => o.date === f.date && o.ext === 'zip')
    })
    .map((f) => f.name)

  return {
    create: alreadyToday ? null : backupFileName(when, format),
    prune,
  }
}

/** Files the shopkeeper should see, newest first. Anything unrecognised is left alone. */
export function sortBackups(files: BackupFile[]): BackupFile[] {
  return describeBackups(files).map(({ name, size }) => ({ name, size }))
}
