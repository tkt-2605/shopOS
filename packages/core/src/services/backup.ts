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
 *
 * The time is optional because it arrived late. A shop that backed up once a
 * day has a folder of `shop-2026-09-12.zip`; once the schedule could say "every
 * three hours" a day needed more than one name, and every archive written since
 * carries the minute it was taken. Only archives: a bare `.db` is never written
 * any more, so it never gains a time.
 */
const NAME = /^shop-(\d{4}-\d{2}-\d{2})(?:\.(db)|(?:-(\d{2})(\d{2}))?\.(zip))$/

/**
 * The copy taken immediately before a restore, so an owner who restores the
 * wrong file has somewhere to go back to.
 *
 * A different shape from a daily backup on purpose. These are not part of the
 * rotation and are never pruned: there are only ever a handful, and the one
 * thing worse than an old restore point is no restore point.
 */
const SAFETY = /^before-restore-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.db$/

/**
 * The copies taken before an upgrade touches the shop's data (`update-rollout.md`,
 * step 8): one before the migrations run against a database older than this
 * build, and one before an update is installed. Safety copies like the one
 * before a restore, so the daily rotation never touches them -- but unlike
 * that one they come round with every release, so each kind keeps its newest
 * `KEEP_SAFETY` and no more.
 */
const BEFORE_SCHEMA = /^before-schema-(\d+)-to-(\d+)-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.db$/
const BEFORE_UPDATE = /^before-update-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.db$/

export const KEEP_SAFETY = 3

export function backupName(when: Date = new Date()): string {
  return `shop-${businessDate(when)}.db`
}

export function backupZipName(when: Date = new Date()): string {
  return `shop-${businessDate(when)}.zip`
}

/** The name every scheduled or pressed-for backup is written under: the minute it was taken. */
export function backupStampName(when: Date = new Date()): string {
  return `shop-${stamp(when)}.zip`
}

export function safetyName(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `before-restore-${businessDate(when)}-${pad(when.getHours())}${pad(when.getMinutes())}.db`
}

function stamp(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${businessDate(when)}-${pad(when.getHours())}${pad(when.getMinutes())}`
}

/** The copy taken before migrating from schema `from` to `to`. */
export function beforeSchemaName(from: number, to: number, when: Date = new Date()): string {
  return `before-schema-${from}-to-${to}-${stamp(when)}.db`
}

/** The copy taken before installing an update over app version `version`. */
export function beforeUpdateName(version: string, when: Date = new Date()): string {
  return `before-update-${version}-${stamp(when)}.db`
}

/**
 * Whether starting this build against this database needs a copy first: the
 * database is behind the build, and is not the empty one a new install makes.
 */
export function needsSchemaCopy(current: number, expected: number): boolean {
  return current > 0 && current < expected
}

/**
 * Upgrade copies beyond the newest `keep` of each kind. The copy before a
 * restore is never on this list; see `SAFETY`.
 */
export function pruneUpgradeCopies(files: BackupFile[], keep: number = KEEP_SAFETY): string[] {
  const out: string[] = []
  for (const kind of [BEFORE_SCHEMA, BEFORE_UPDATE]) {
    const named = files.map((f) => f.name).filter((n) => kind.test(n))
    // The stamp sorts as text; the version or schema numbers before it do not,
    // so order by what follows them.
    const byTime = named
      .map((n) => ({ n, at: n.replace(/^.*-(\d{4}-\d{2}-\d{2}-\d{4})\.db$/, '$1') }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    out.push(...byTime.slice(Math.max(0, keep)).map((x) => x.n))
  }
  return out
}

export function backupDate(name: string): string | null {
  return NAME.exec(name)?.[1] ?? null
}

export function backupExt(name: string): BackupFormat | null {
  const m = NAME.exec(name)
  if (!m) return null
  return m[2] === 'db' ? 'db' : 'zip'
}

/** `HH:MM` for a backup named with its minute, null for the older one-a-day names. */
export function backupTime(name: string): string | null {
  const m = NAME.exec(name)
  return m?.[3] && m[4] ? `${m[3]}:${m[4]}` : null
}

/**
 * When a daily backup was taken, as a local time.
 *
 * A name without a minute counts as the start of its day. That is the cautious
 * reading: on the morning a shop upgrades, its untimed backup from earlier
 * today does not stand in for a slot it may have been taken before.
 */
export function backupTakenAt(name: string): Date | null {
  const date = backupDate(name)
  if (!date) return null
  const time = backupTime(name) ?? '00:00'
  return new Date(`${date}T${time}:00`)
}

export type BackupKind = 'daily' | 'safety'

export interface BackupEntry extends BackupFile {
  date: string
  /** `HH:MM`, or null for a daily backup from before they were named by the minute. */
  time: string | null
  kind: BackupKind
  format: BackupFormat
  /** For a safety copy, what it was taken before. */
  before?: 'restore' | 'schema' | 'update'
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
      entries.push({ ...f, date: daily[1]!, time: backupTime(f.name), kind: 'daily', format: backupExt(f.name)! })
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
        before: 'restore',
      })
      continue
    }
    const schema = BEFORE_SCHEMA.exec(f.name)
    if (schema) {
      entries.push({
        ...f, date: schema[3]!, time: `${schema[4]}:${schema[5]}`, kind: 'safety', format: 'db', before: 'schema',
      })
      continue
    }
    const update = BEFORE_UPDATE.exec(f.name)
    if (update) {
      entries.push({
        ...f, date: update[2]!, time: `${update[3]}:${update[4]}`, kind: 'safety', format: 'db', before: 'update',
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
  /** The file to write, or null when the latest slot is already covered. */
  create: string | null
  /** Files to remove once the new one exists. */
  prune: string[]
}

/* ------------------------------------------------------- the schedule --- */

/**
 * How often this machine backs up, and from what time.
 *
 * `every` divides the day evenly, so the slots are the same every day: every
 * 6 hours from 02:00 is 02:00, 08:00, 14:00 and 20:00, today and every day.
 * Nothing less often than daily is offered. A week between backups is a week
 * of bills a dead disk takes with it, and a shopkeeper choosing from a list
 * cannot see that cost in the word "weekly".
 */
export interface BackupSchedule {
  /** Hours between backups. */
  every: BackupEvery
  /** Minutes after midnight, local, of the first backup of the day. */
  at: number
}

export const BACKUP_EVERY = [24, 12, 6, 3, 1] as const
export type BackupEvery = typeof BACKUP_EVERY[number]

/** 02:00, once a day: the shutters are down everywhere and nobody is mid-bill. */
export const DEFAULT_SCHEDULE: BackupSchedule = { every: 24, at: 2 * 60 }

/**
 * A schedule from the two strings a machine keeps, or the default for anything
 * it does not recognise. A setting that will not parse must not mean "never".
 */
export function parseSchedule(every: string | null, at: string | null): BackupSchedule {
  const hours = Number(every)
  const picked = (BACKUP_EVERY as readonly number[]).includes(hours)
    ? (hours as BackupEvery)
    : DEFAULT_SCHEDULE.every
  const m = /^(\d{2}):(\d{2})$/.exec(at ?? '')
  const minutes = m && Number(m[1]) < 24 && Number(m[2]) < 60
    ? Number(m[1]) * 60 + Number(m[2])
    : DEFAULT_SCHEDULE.at
  return { every: picked, at: minutes }
}

/** `HH:MM` for the minutes-after-midnight a schedule keeps. */
export function formatClock(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** The slots of one day, in minutes after midnight, earliest first. */
export function slotsOfDay(schedule: BackupSchedule): number[] {
  const step = schedule.every * 60
  const out: number[] = []
  for (let t = schedule.at % step; t < 24 * 60; t += step) out.push(t)
  return out
}

/**
 * Local, built with `setHours`, never by adding milliseconds to midnight: the
 * slot is "08:00 on the shop's clock", and arithmetic in UTC is how a backup
 * meant for the small hours lands in the evening rush.
 */
function atMinutes(day: Date, minutes: number): Date {
  const d = new Date(day)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d
}

/** The most recent slot at or before `now`. */
export function lastSlot(schedule: BackupSchedule, now: Date = new Date()): Date {
  const slots = slotsOfDay(schedule)
  const minute = now.getHours() * 60 + now.getMinutes()
  const today = slots.filter((t) => t <= minute)
  if (today.length > 0) return atMinutes(now, today[today.length - 1]!)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  return atMinutes(yesterday, slots[slots.length - 1]!)
}

/** The first slot strictly after `now`. */
export function nextSlot(schedule: BackupSchedule, now: Date = new Date()): Date {
  const slots = slotsOfDay(schedule)
  const minute = now.getHours() * 60 + now.getMinutes()
  const later = slots.find((t) => t > minute)
  if (later !== undefined) return atMinutes(now, later)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return atMinutes(tomorrow, slots[0]!)
}

interface Dated {
  name: string
  date: string
  at: Date
  ext: BackupFormat
}

/**
 * Whether a backup is due, what to call it, and which ones to throw away.
 *
 * **Due** when nothing has been written since the latest slot. That one rule
 * covers the machine switched on at nine (the 02:00 slot passed with nothing
 * written), the machine left on all night (the timer reaches the slot), and
 * the till opened twice before lunch (the second opening finds the first's
 * backup). A backup named in the future -- the clock was wrong and has since
 * been corrected -- covers nothing, or one bad night's clock would switch
 * backups off until the calendar caught up with it.
 *
 * **Kept**: the newest `keep` days. Today keeps every backup it has; an earlier
 * day keeps only its last, which is the one with the whole day in it. So a
 * shop backing up every hour has a fortnight on disk and not three hundred
 * files, and a shop backing up once a day keeps exactly what it always kept.
 * Counted in days, not files, and computed as if the new file already existed,
 * so the count never dips below `keep` in the window between writing and
 * deleting.
 */
export function planBackup(
  existing: BackupFile[],
  now: Date = new Date(),
  schedule: BackupSchedule = DEFAULT_SCHEDULE,
  keep: number = KEEP_DAILY,
): BackupPlan {
  const dated = existing
    .map((f) => ({ name: f.name, date: backupDate(f.name), at: backupTakenAt(f.name), ext: backupExt(f.name) }))
    .filter((f): f is Dated => f.date !== null && f.at !== null && f.ext !== null)

  const slot = lastSlot(schedule, now).getTime()
  const covered = dated.some((f) => f.at.getTime() >= slot && f.at.getTime() <= now.getTime())
  const create = covered ? null : backupStampName(now)

  const today = businessDate(now)
  const dates = new Set(dated.map((f) => f.date))
  if (create) dates.add(today)

  // Newest first, so the tail is what falls off the end.
  const ordered = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const kept = new Set(ordered.slice(0, Math.max(1, keep)))

  const prune: string[] = []
  for (const date of dates) {
    const ofDay = dated.filter((f) => f.date === date)
    if (!kept.has(date)) {
      prune.push(...ofDay.map((f) => f.name))
      continue
    }
    if (date === today) continue
    // The last of an earlier day stays. Between two of the same minute -- the
    // `.db` and `.zip` of the day a shop upgraded -- the zip stays: it is the
    // db with the photographs added.
    const last = [...ofDay].sort((a, b) =>
      b.at.getTime() - a.at.getTime() || (a.ext === b.ext ? 0 : a.ext === 'zip' ? -1 : 1))[0]!
    prune.push(...ofDay.filter((f) => f !== last).map((f) => f.name))
  }

  return { create, prune: prune.sort() }
}

/** Files the shopkeeper should see, newest first. Anything unrecognised is left alone. */
export function sortBackups(files: BackupFile[]): BackupFile[] {
  return describeBackups(files).map(({ name, size }) => ({ name, size }))
}
