import { describe, it, expect } from 'vitest'
import {
  planBackup, backupName, backupZipName, safetyName, backupDate, backupExt,
  describeBackups, sortBackups, KEEP_DAILY,
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
  it('takes one on a day with none', () => {
    expect(planBackup([], on('2026-09-12'))).toEqual({ create: 'shop-2026-09-12.db', prune: [] })
  })

  it('does not take a second one the same day', () => {
    const plan = planBackup(files('shop-2026-09-12.db'), on('2026-09-12'))
    expect(plan.create).toBeNull()
    expect(plan.prune).toEqual([])
  })

  it('keeps a fortnight and drops what falls off the end', () => {
    const existing = files(
      ...Array.from({ length: 20 }, (_, i) => `shop-2026-08-${String(i + 1).padStart(2, '0')}.db`),
    )
    const plan = planBackup(existing, on('2026-09-12'))

    expect(plan.create).toBe('shop-2026-09-12.db')
    expect(plan.prune).toHaveLength(20 + 1 - KEEP_DAILY)
    // The oldest go, the newest stay.
    expect(plan.prune).toContain('shop-2026-08-01.db')
    expect(plan.prune).not.toContain('shop-2026-08-20.db')
  })

  /* Pruning before the new file exists is how a shop ends up with thirteen backups
     and a crash halfway through the fourteenth. */
  it('never counts the new backup as one of the ones it may delete', () => {
    const existing = files(
      ...Array.from({ length: 14 }, (_, i) => `shop-2026-09-${String(i + 1).padStart(2, '0')}.db`),
    )
    const plan = planBackup(existing, on('2026-09-20'))
    expect(plan.prune).toEqual(['shop-2026-09-01.db'])
    expect(plan.prune).not.toContain(plan.create)
  })

  it('leaves files it does not recognise alone', () => {
    const plan = planBackup(files('shop.db', 'before-upgrade.db', 'shop-2026-09-11.db'), on('2026-09-12'))
    expect(plan.prune).toEqual([])
  })

  it('refuses to delete everything even if told to keep none', () => {
    const plan = planBackup(files('shop-2026-09-10.db', 'shop-2026-09-11.db'), on('2026-09-12'), 0)
    expect(plan.prune).not.toContain('shop-2026-09-12.db')
    expect(plan.prune).toHaveLength(2)
  })
})

describe('listing', () => {
  it('shows the newest first', () => {
    const sorted = sortBackups(files('shop-2026-09-01.db', 'shop-2026-09-12.db', 'shop-2026-09-05.db'))
    expect(sorted.map((f) => f.name)).toEqual([
      'shop-2026-09-12.db', 'shop-2026-09-05.db', 'shop-2026-09-01.db',
    ])
  })
})

/* A shop that upgrades has a folder of .db files it must still be able to see,
   prune and restore. Everything below is about that mixed folder. */
describe('the move from .db to .zip', () => {
  it('reads a date and a format off either', () => {
    expect(backupZipName(new Date(2026, 8, 13, 0, 30))).toBe('shop-2026-09-13.zip')
    expect(backupDate('shop-2026-09-12.zip')).toBe('2026-09-12')
    expect(backupExt('shop-2026-09-12.zip')).toBe('zip')
    expect(backupExt('shop-2026-09-12.db')).toBe('db')
    expect(backupExt('shop-2026-09-12.db-wal')).toBeNull()
    expect(backupExt('shop-2026-09-12.exe')).toBeNull()
  })

  it('writes a zip when asked for one', () => {
    expect(planBackup([], on('2026-09-12'), KEEP_DAILY, 'zip').create).toBe('shop-2026-09-12.zip')
  })

  /* The day of the upgrade: today's .db already stands for today, and taking a
     zip beside it would back the same morning up twice. */
  it('does not take a zip on a day that already has a db', () => {
    const plan = planBackup(files('shop-2026-09-12.db'), on('2026-09-12'), KEEP_DAILY, 'zip')
    expect(plan.create).toBeNull()
  })

  /* Slicing a list of files rather than a list of days would keep seven days
     through the transition week and call it fourteen. */
  it('keeps a fortnight of days, not a fortnight of files', () => {
    const existing = files(
      ...Array.from({ length: 10 }, (_, i) => `shop-2026-09-${String(i + 1).padStart(2, '0')}.db`),
      ...Array.from({ length: 10 }, (_, i) => `shop-2026-09-${String(i + 1).padStart(2, '0')}.zip`),
    )
    const plan = planBackup(existing, on('2026-09-11'), KEEP_DAILY, 'zip')

    expect(plan.create).toBe('shop-2026-09-11.zip')
    // Eleven days in play, all inside the fortnight — so nothing falls off the
    // end, and only the superseded .db files go.
    expect(plan.prune).toHaveLength(10)
    expect(plan.prune.every((n) => n.endsWith('.db'))).toBe(true)
    expect(plan.prune).not.toContain('shop-2026-09-10.zip')
  })

  it('drops a db the moment a zip for the same day exists', () => {
    const plan = planBackup(
      files('shop-2026-09-11.db', 'shop-2026-09-11.zip', 'shop-2026-09-10.db'),
      on('2026-09-12'), KEEP_DAILY, 'zip',
    )
    expect(plan.prune).toEqual(['shop-2026-09-11.db'])
  })

  it('prunes every file belonging to a day that has fallen off the end', () => {
    const plan = planBackup(
      files('shop-2026-08-01.db', 'shop-2026-08-01.zip', 'shop-2026-09-12.zip'),
      on('2026-09-12'), 1, 'zip',
    )
    expect(plan.prune.sort()).toEqual(['shop-2026-08-01.db', 'shop-2026-08-01.zip'])
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
      on('2026-09-13'), 1, 'zip',
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

