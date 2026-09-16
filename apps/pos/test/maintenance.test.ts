import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { migrate, newId, type SqlDriver } from '@shopos/core'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'

/**
 * The weekly stock replay, and when it runs.
 *
 * The replay itself is core's and is tested there. What matters here is the
 * schedule and the bookkeeping: that it does not run six nights out of seven,
 * that it does run on a machine that was switched off for the seventh, and that
 * what it found survives to the Dashboard — which is now a reader of this
 * rather than a caller of the replay.
 */

const deviceSettings = new Map<string, string>()
vi.mock('../src/core/device', () => ({
  deviceSetting: (key: string) => deviceSettings.get(key) ?? null,
  setDeviceSetting: async (key: string, value: string | null) => {
    if (value === null || value === '') deviceSettings.delete(key)
    else deviceSettings.set(key, value)
    return true
  },
}))

const logged: { level: string; message: string }[] = []
vi.mock('../src/core/log', () => ({
  logEvent: (level: string, _source: string, message: string) => { logged.push({ level, message }) },
}))

const {
  lastStockCheck, recordStockCheck, stockCheckIsDue, runStockCheck,
  startMaintenanceTimer, STOCK_CHECK_INTERVAL_MS,
} = await import('../src/core/maintenance')

let db: SqlDriver

beforeEach(async () => {
  deviceSettings.clear()
  logged.length = 0
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
})

/** A product with a cache row that the ledger does not agree with. */
async function driftingProduct(): Promise<string> {
  const id = newId()
  const now = '2026-09-01T00:00:00.000Z'
  await db.execute(
    `INSERT INTO products (id, name, base_unit, created_at, updated_at) VALUES (?, 'Rice', 'kg', ?, ?)`,
    [id, now, now],
  )
  await db.execute(
    `INSERT INTO product_stock (product_id, qty_on_hand, stock_value, updated_at) VALUES (?, ?, 0, ?)`,
    [id, 50_000, now],
  )
  return id
}

describe('when the replay is due', () => {
  it('is due on a machine that has never run one', () => {
    expect(lastStockCheck()).toBeNull()
    expect(stockCheckIsDue()).toBe(true)
  })

  it('is not due again the next night', async () => {
    const at = '2026-09-10T02:00:00.000Z'
    await recordStockCheck({ at, drift: 0 })
    expect(stockCheckIsDue(new Date('2026-09-11T02:00:00.000Z'))).toBe(false)
    expect(stockCheckIsDue(new Date('2026-09-16T02:00:00.000Z'))).toBe(false)
  })

  it('is due again a week later', async () => {
    const at = '2026-09-10T02:00:00.000Z'
    await recordStockCheck({ at, drift: 0 })
    expect(stockCheckIsDue(new Date(Date.parse(at) + STOCK_CHECK_INTERVAL_MS))).toBe(true)
  })

  it('is due when the machine says the check happened in the future', () => {
    /* A till whose clock was wrong is exactly the till somebody has just been
       fixing. Without this it would sit there believing it had already run,
       and never replay again. */
    expect(stockCheckIsDue(new Date('2026-09-16T00:00:00.000Z'), {
      at: '2027-01-01T00:00:00.000Z', drift: 0,
    })).toBe(true)
  })

  it('is due when what the machine wrote down cannot be read as a date', () => {
    expect(stockCheckIsDue(new Date(), { at: 'the other day', drift: 0 })).toBe(true)
  })
})

describe('running it', () => {
  it('records what it found where the Dashboard reads it', async () => {
    await driftingProduct()
    const check = await runStockCheck(db, { now: new Date('2026-09-16T02:00:00.000Z') })

    expect(check).toEqual({ at: '2026-09-16T02:00:00.000Z', drift: 1 })
    expect(lastStockCheck()).toEqual({ at: '2026-09-16T02:00:00.000Z', drift: 1 })
  })

  it('reports and does not repair', async () => {
    /* Drift means something wrote stock outside the one module allowed to.
       Quietly correcting that every week would repair the shop for ever and
       never tell anybody the bug was still happening. The repair stays behind a
       person pressing a button on Inventory. */
    const id = await driftingProduct()
    await runStockCheck(db, { force: true })

    const row = await db.get<{ qty_on_hand: number }>(
      `SELECT qty_on_hand FROM product_stock WHERE product_id = ?`, [id],
    )
    expect(row?.qty_on_hand).toBe(50_000)
  })

  it('does nothing on the nights it is not due', async () => {
    await recordStockCheck({ at: '2026-09-15T02:00:00.000Z', drift: 4 })
    await driftingProduct()

    expect(await runStockCheck(db, { now: new Date('2026-09-16T02:00:00.000Z') })).toBeNull()
    // And the old answer is left alone rather than overwritten with a zero.
    expect(lastStockCheck()).toEqual({ at: '2026-09-15T02:00:00.000Z', drift: 4 })
  })

  it('runs anyway when told to', async () => {
    await recordStockCheck({ at: '2026-09-15T02:00:00.000Z', drift: 4 })
    const check = await runStockCheck(db, { now: new Date('2026-09-16T02:00:00.000Z'), force: true })
    expect(check?.drift).toBe(0)
  })

  it('writes a line to the log either way', async () => {
    await runStockCheck(db, { force: true })
    expect(logged.at(-1)).toMatchObject({ level: 'info' })
    expect(logged.at(-1)!.message).toContain('0 product(s) adrift')

    await driftingProduct()
    await runStockCheck(db, { force: true })
    expect(logged.at(-1)).toMatchObject({ level: 'warn' })
    expect(logged.at(-1)!.message).toContain('1 product(s) adrift')
  })
})

describe('the timer', () => {
  it('fires at the next two o\'clock and arms itself again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T20:00:00'))
    try {
      const seen: number[] = []
      const stop = startMaintenanceTimer(db, (check) => seen.push(check.drift))

      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
      expect(seen).toEqual([0])

      /* The second night is a no-op, and a no-op must not report — the
         Dashboard would otherwise be told "checked, nothing wrong" on a night
         when nothing was checked. */
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(seen).toEqual([0])

      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops when told to', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T20:00:00'))
    try {
      const seen: number[] = []
      startMaintenanceTimer(db, (check) => seen.push(check.drift))()

      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000)
      expect(seen).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives a replay that throws, and keeps the timer armed', async () => {
    /* Housekeeping at two in the morning must not take down the thing that
       carries it. The till has to open in the morning regardless. */
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T20:00:00'))
    try {
      await db.close()
      const stop = startMaintenanceTimer(db, () => { throw new Error('never reached') })
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)

      expect(logged.some((l) => l.level === 'error' && l.message.includes('Stock replay failed')))
        .toBe(true)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
