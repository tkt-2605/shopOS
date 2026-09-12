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

export interface BackupFile {
  name: string
  /** Bytes. Shown to the shopkeeper so an empty backup is visible as one. */
  size: number
}

const NAME = /^shop-(\d{4}-\d{2}-\d{2})\.db$/

export function backupName(when: Date = new Date()): string {
  return `shop-${businessDate(when)}.db`
}

export function backupDate(name: string): string | null {
  return NAME.exec(name)?.[1] ?? null
}

export interface BackupPlan {
  /** The file to write, or null when today's is already on disk. */
  create: string | null
  /** Files to remove once the new one exists. */
  prune: string[]
}

/**
 * One backup a day, keeping the most recent `keep`.
 *
 * Pruning is deliberately computed as if the new backup already existed, so the
 * count never dips below `keep` in the window between writing and deleting.
 */
export function planBackup(
  existing: BackupFile[],
  when: Date = new Date(),
  keep: number = KEEP_DAILY,
): BackupPlan {
  const today = backupName(when)
  const dated = existing
    .map((f) => ({ name: f.name, date: backupDate(f.name) }))
    .filter((f): f is { name: string; date: string } => f.date !== null)

  const alreadyToday = dated.some((f) => f.name === today)
  const after = alreadyToday ? dated : [...dated, { name: today, date: businessDate(when) }]

  // Newest first, so the tail is what falls off the end.
  const ordered = [...after].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  return {
    create: alreadyToday ? null : today,
    prune: ordered.slice(Math.max(1, keep)).map((f) => f.name),
  }
}

/** Files the shopkeeper should see, newest first. Anything unrecognised is left alone. */
export function sortBackups(files: BackupFile[]): BackupFile[] {
  return [...files]
    .filter((f) => backupDate(f.name) !== null)
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
}
