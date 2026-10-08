import { describe, it, expect } from 'vitest'
import {
  planBackup, backupName, backupZipName, backupStampName, safetyName, backupDate, backupExt,
  describeBackups, sortBackups, KEEP_DAILY,
  parseSchedule, slotsOfDay, lastSlot, nextSlot, formatClock, DEFAULT_SCHEDULE, type BackupEvery,
  beforeSchemaName, beforeUpdateName, needsSchemaCopy, pruneUpgradeCopies, KEEP_SAFETY,
} from '../src/services/backup.js'

const on = (iso: string) => new Date(`${iso}T11:00:00`)
const files = (...names: string[]) => names.map((name) => ({ name, size: 1024 }))

describe('backup naming', () => {
  it('names a backup after the shop’s day, not UTC’s', () => {
    expect(backupName(new Date(2026, 8, 13, 0, 30))).toBe('shop-2026-09-13.db')
  })

  it('reads the date back out, and ignores anything it did not write', () => {
    expect(backupDate('shop-2026-09-12.db')).toBe('2026-09-12')
    expect(backupDate('shop.db')).toBeNull()
    expect(backupDate('holiday-photos.db')).toBeNull()
  })
})

describe('backup plan', () => {
  it('takes one when the day has none', () => {
    expect(planBackup([], on('2026-09-12'))).toEqual({ create: 'shop-2026-09-12-1100.zip', prune: [] })
  })

  it('does not take a second one before the next slot', () => {
    const plan = planBackup(files('shop-2026-09-12-0900.zip'), on('2026-09-12'))
    expect(plan.create).toBeNull()
    expect(plan.prune).toEqual([])
  })

  it('keeps a fortnight and drops what falls off the end', () => {
    const existing = files(
      ...Array.from({ length: 20 }, (_, i) => `shop-2026-08-${String(i + 1).padStart(2, '0')}-0200.zip`),
    )
    const plan = planBackup(existing, on('2026-09-12'))

    expect(plan.create).toBe('shop-2026-09-12-1100.zip')
    expect(plan.prune).toHaveLength(20 + 1 - KEEP_DAILY)
    // The oldest go, the newest stay.
    expect(plan.prune).toContain('shop-2026-08-01-0200.zip')
    expect(plan.prune).not.toContain('shop-2026-08-20-0200.zip')
  })

  /* Pruning before the new file exists is how a shop ends up with thirteen backups
     and a crash halfway through the fourteenth. */
  it('never counts the new backup as one of the ones it may delete', () => {
    const existing = files(
      ...Array.from({ length: 14 }, (_, i) => `shop-2026-09-${String(i + 1).padStart(2, '0')}-0200.zip`),
    )
    const plan = planBackup(existing, on('2026-09-20'))
    expect(plan.prune).toEqual(['shop-2026-09-01-0200.zip'])
    expect(plan.prune).not.toContain(plan.create)
  })

  it('leaves files it does not recognise alone', () => {
    const plan = planBackup(files('shop.db', 'before-upgrade.db', 'shop-2026-09-11.db'), on('2026-09-12'))
    expect(plan.prune).toEqual([])
  })

  it('refuses to delete everything even if told to keep none', () => {
    const plan = planBackup(files('shop-2026-09-10.db', 'shop-2026-09-11.db'), on('2026-09-12'), DEFAULT_SCHEDULE, 0)
    expect(plan.create).toBe('shop-2026-09-12-1100.zip')
    expect(plan.prune).toHaveLength(2)
  })
})

describe('the schedule', () => {
  const every = (hours: BackupEvery, at: string) => parseSchedule(String(hours), at)

  it('reads what a machine keeps, and falls back to 02:00 once a day on anything else', () => {
    expect(parseSchedule('6', '07:30')).toEqual({ every: 6, at: 7 * 60 + 30 })
    expect(parseSchedule(null, null)).toEqual(DEFAULT_SCHEDULE)
    expect(parseSchedule('5', '25:00'), 'not a choice on the list').toEqual(DEFAULT_SCHEDULE)
    expect(parseSchedule('168', '02:00').every, 'weekly is not offered').toBe(24)
  })

  it('divides the day evenly from the chosen time', () => {
    expect(slotsOfDay(every(6, '02:00')).map(formatClock)).toEqual(['02:00', '08:00', '14:00', '20:00'])
    // From 21:00 every 12 hours is also 09:00 -- the day is the same every day.
    expect(slotsOfDay(every(12, '21:00')).map(formatClock)).toEqual(['09:00', '21:00'])
    expect(slotsOfDay(every(1, '00:15'))).toHaveLength(24)
  })

  it('finds the slot just gone and the one coming, across midnight', () => {
    const s = every(6, '02:00')
    expect(lastSlot(s, new Date(2026, 9, 9, 15, 0))).toEqual(new Date(2026, 9, 9, 14, 0))
    expect(lastSlot(s, new Date(2026, 9, 9, 1, 0)), 'before the first: yesterday’s last').toEqual(new Date(2026, 9, 8, 20, 0))
    expect(nextSlot(s, new Date(2026, 9, 9, 14, 0)), 'strictly after').toEqual(new Date(2026, 9, 9, 20, 0))
    expect(nextSlot(s, new Date(2026, 9, 9, 21, 0))).toEqual(new Date(2026, 9, 10, 2, 0))
  })

  it('is due again once a slot passes with nothing written since', () => {
    const s = every(3, '00:00')
    const taken = files('shop-2026-10-09-1000.zip')
    expect(planBackup(taken, new Date(2026, 9, 9, 11, 30), s).create).toBeNull()
    expect(planBackup(taken, new Date(2026, 9, 9, 12, 1), s).create).toBe('shop-2026-10-09-1201.zip')
  })

  it('covers the 02:00 slot with the backup taken when the shop opened', () => {
    const opened = files('shop-2026-10-09-0915.zip')
    expect(planBackup(opened, new Date(2026, 9, 9, 23, 0)).create).toBeNull()
    expect(planBackup(opened, new Date(2026, 9, 10, 2, 0)).create).toBe('shop-2026-10-10-0200.zip')
  })

  /* A clock that ran a day fast and was corrected would otherwise leave a
     backup named tomorrow standing in for every slot until tomorrow came. */
  it('does not let a backup named in the future cover anything', () => {
    const plan = planBackup(files('shop-2026-10-10-0200.zip'), new Date(2026, 9, 9, 11, 0))
    expect(plan.create).toBe('shop-2026-10-09-1100.zip')
  })

  /* An untimed name could have been taken at any minute of its day. */
  it('treats an old one-a-day name as taken at midnight', () => {
    expect(planBackup(files('shop-2026-10-09.zip'), new Date(2026, 9, 9, 11, 0)).create).not.toBeNull()
    expect(planBackup(files('shop-2026-10-09.zip'), new Date(2026, 9, 9, 11, 0), every(24, '00:00')).create).toBeNull()
  })

  it('keeps every backup of today and the last of each earlier day', () => {
    const plan = planBackup(
      files(
        'shop-2026-10-08-0800.zip', 'shop-2026-10-08-1400.zip', 'shop-2026-10-08-2000.zip',
        'shop-2026-10-09-0200.zip', 'shop-2026-10-09-0800.zip',
      ),
      new Date(2026, 9, 9, 14, 0), every(6, '02:00'),
    )
    expect(plan.create).toBe('shop-2026-10-09-1400.zip')
    expect(plan.prune).toEqual(['shop-2026-10-08-0800.zip', 'shop-2026-10-08-1400.zip'])
  })
})

describe('listing', () => {
  it('shows the newest first', () => {
    const sorted = sortBackups(files('shop-2026-09-01.db', 'shop-2026-09-12.db', 'shop-2026-09-05.db'))
    expect(sorted.map((f) => f.name)).toEqual([
      'shop-2026-09-12.db', 'shop-2026-09-05.db', 'shop-2026-09-01.db',
    ])
  })

  it('puts the time on a backup named with one, and orders a day by it', () => {
    const listed = describeBackups(files('shop-2026-09-12-0800.zip', 'shop-2026-09-12.zip', 'shop-2026-09-12-1400.zip'))
    expect(listed.map((f) => f.time)).toEqual(['14:00', '08:00', null])
    expect(listed[0]).toMatchObject({ kind: 'daily', format: 'zip', date: '2026-09-12' })
  })
})

/* A shop that upgrades has a folder of .db files it must still be able to see,
   prune and restore. Everything below is about that mixed folder. */
describe('the move from .db to .zip', () => {
  it('reads a date and a format off either', () => {
    expect(backupZipName(new Date(2026, 8, 13, 0, 30))).toBe('shop-2026-09-13.zip')
    expect(backupDate('shop-2026-09-12.zip')).toBe('2026-09-12')
    expect(backupExt('shop-2026-09-12.zip')).toBe('zip')
    expect(backupExt('shop-2026-09-12-0930.zip')).toBe('zip')
    expect(backupExt('shop-2026-09-12.db')).toBe('db')
    expect(backupExt('shop-2026-09-12-0930.db'), 'a db is never named by the minute').toBeNull()
    expect(backupExt('shop-2026-09-12.db-wal')).toBeNull()
    expect(backupExt('shop-2026-09-12.exe')).toBeNull()
  })

  it('names a new backup by the minute, as an archive', () => {
    expect(backupStampName(new Date(2026, 8, 13, 0, 30))).toBe('shop-2026-09-13-0030.zip')
  })

  /* Slicing a list of files rather than a list of days would keep seven days
     through the transition week and call it fourteen. */
  it('keeps a fortnight of days, not a fortnight of files', () => {
    const existing = files(
      ...Array.from({ length: 10 }, (_, i) => `shop-2026-09-${String(i + 1).padStart(2, '0')}.db`),
      ...Array.from({ length: 10 }, (_, i) => `shop-2026-09-${String(i + 1).padStart(2, '0')}.zip`),
    )
    const plan = planBackup(existing, on('2026-09-11'))

    expect(plan.create).toBe('shop-2026-09-11-1100.zip')
    // Eleven days in play, all inside the fortnight — so nothing falls off the
    // end, and only the superseded .db files go.
    expect(plan.prune).toHaveLength(10)
    expect(plan.prune.every((n) => n.endsWith('.db'))).toBe(true)
    expect(plan.prune).not.toContain('shop-2026-09-10.zip')
  })

  it('drops a db once a zip for the same earlier day exists', () => {
    const plan = planBackup(
      files('shop-2026-09-11.db', 'shop-2026-09-11.zip', 'shop-2026-09-10.db'),
      on('2026-09-12'),
    )
    expect(plan.prune).toEqual(['shop-2026-09-11.db'])
  })

  it('prunes every file belonging to a day that has fallen off the end', () => {
    const plan = planBackup(
      files('shop-2026-08-01.db', 'shop-2026-08-01.zip', 'shop-2026-09-12-0200.zip'),
      on('2026-09-12'), DEFAULT_SCHEDULE, 1,
    )
    expect(plan.prune).toEqual(['shop-2026-08-01.db', 'shop-2026-08-01.zip'])
  })

  it('lists both formats, newest first', () => {
    const sorted = sortBackups(files('shop-2026-09-01.db', 'shop-2026-09-12.zip', 'shop-2026-09-05.zip'))
    expect(sorted.map((f) => f.name)).toEqual([
      'shop-2026-09-12.zip', 'shop-2026-09-05.zip', 'shop-2026-09-01.db',
    ])
  })
})

/* The copy taken just before a restore. It is not part of the rotation — it is
   the only way back from restoring the wrong file. */
describe('pre-restore copies', () => {
  it('is named for the minute it was taken', () => {
    expect(safetyName(new Date(2026, 8, 13, 9, 5))).toBe('before-restore-2026-09-13-0905.db')
  })

  it('is not a daily backup, so the rotation never touches it', () => {
    expect(backupDate('before-restore-2026-09-13-0905.db')).toBeNull()
    const plan = planBackup(
      files('before-restore-2026-09-13-0905.db', 'shop-2026-01-01.db'),
      on('2026-09-13'), DEFAULT_SCHEDULE, 1,
    )
    expect(plan.prune).toEqual(['shop-2026-01-01.db'])
  })

  it('still appears in the list, marked for what it is', () => {
    const listed = describeBackups(files(
      'shop-2026-09-12.zip',
      'before-restore-2026-09-13-0905.db',
      'shop-2026-09-13.zip',
      'holiday-photos.db',
    ))
    // The safety copy is above the same day's backup because it is newer: the
    // rotation runs when the shop opens, a restore happens later.
    expect(listed.map((f) => f.name)).toEqual([
      'before-restore-2026-09-13-0905.db',
      'shop-2026-09-13.zip',
      'shop-2026-09-12.zip',
    ])
    expect(listed[0]).toMatchObject({ kind: 'safety', time: '09:05', format: 'db' })
    expect(listed[1]).toMatchObject({ kind: 'daily', time: null, format: 'zip' })
  })
})

describe('the copies taken before an upgrade', () => {
  const at = new Date(2026, 8, 27, 19, 5)

  it('names what it was taken before, and when', () => {
    expect(beforeSchemaName(61, 62, at)).toBe('before-schema-61-to-62-2026-09-27-1905.db')
    expect(beforeUpdateName('0.1.0', at)).toBe('before-update-0.1.0-2026-09-27-1905.db')
  })

  it('is taken for a database behind the build, and not for a new one or a current one', () => {
    expect(needsSchemaCopy(61, 62)).toBe(true)
    expect(needsSchemaCopy(0, 62), 'a fresh install has nothing to lose').toBe(false)
    expect(needsSchemaCopy(62, 62)).toBe(false)
  })

  it('is listed as a safety copy, saying what it came before', () => {
    const [schema, update] = describeBackups(files(
      beforeSchemaName(61, 62, at), beforeUpdateName('0.1.0', new Date(2026, 8, 26, 9, 0)),
    ))
    expect(schema).toMatchObject({ kind: 'safety', before: 'schema', date: '2026-09-27', time: '19:05' })
    expect(update).toMatchObject({ kind: 'safety', before: 'update', date: '2026-09-26' })
  })

  it('is never touched by the daily rotation', () => {
    const plan = planBackup(files(beforeSchemaName(61, 62, at)), on('2027-01-01'))
    expect(plan.prune).toEqual([])
  })

  it('keeps the newest few of each kind, by when they were taken, and never a restore point', () => {
    const schema = [1, 2, 3, 4].map((d) => beforeSchemaName(9 + d, 10 + d, new Date(2026, 8, d, 9, 0)))
    const updates = ['0.9.0', '0.10.0'].map((v, i) => beforeUpdateName(v, new Date(2026, 8, 10 + i, 9, 0)))
    const gone = pruneUpgradeCopies(files(...schema, ...updates, safetyName(new Date(2026, 0, 1, 9, 0))))
    expect(KEEP_SAFETY).toBe(3)
    expect(gone, 'the oldest by date, although 10 sorts before 9 as text').toEqual([schema[0]])
  })
})

