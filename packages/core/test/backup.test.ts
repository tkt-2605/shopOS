import { describe, it, expect } from 'vitest'
import { planBackup, backupName, backupDate, sortBackups, KEEP_DAILY } from '../src/services/backup.js'

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
