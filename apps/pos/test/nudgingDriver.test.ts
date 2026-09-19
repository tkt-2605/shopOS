import { describe, it, expect, vi } from 'vitest'
import type { SqlDriver } from '@shopos/core'
import { nudgingDriver } from '../src/core/nudgingDriver'

/**
 * The tap on the shoulder after a write.
 *
 * What matters here is which calls count as news and which do not, because the
 * answer decides whether the other counter hears about a sale in half a second
 * or in three quarters of a minute — and, in the other direction, whether
 * reading a screen sets off a round.
 */

function fake(over: Partial<SqlDriver> = {}): SqlDriver {
  return {
    query: async () => [],
    get: async () => undefined,
    queryValues: async () => [],
    execute: async () => ({ changes: 1, lastInsertRowid: 1 }),
    transaction: async (fn) => fn(fake()),
    close: async () => undefined,
    ...over,
  } as SqlDriver
}

describe('a driver that tells the other till', () => {
  it('says nothing about a read', async () => {
    // Most of what the app does, and none of it is news.
    const wrote = vi.fn()
    const db = nudgingDriver(fake(), wrote)

    await db.query('SELECT 1')
    await db.get('SELECT 1')
    await db.queryValues('SELECT 1')

    expect(wrote).not.toHaveBeenCalled()
  })

  it('speaks up after a write', async () => {
    const wrote = vi.fn()
    await nudgingDriver(fake(), wrote).execute('UPDATE products SET name = ?', ['x'])
    expect(wrote).toHaveBeenCalledTimes(1)
  })

  it('speaks up once for a transaction, not once per statement', async () => {
    /* Submitting a bill is one transaction and several rows. One round carrying
       the batch is the point; a round per row is the same batch sent five times. */
    const wrote = vi.fn()
    const db = nudgingDriver(fake(), wrote)

    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO bills VALUES (?)', ['b1'])
      await tx.execute('INSERT INTO bill_items VALUES (?)', ['i1'])
      await tx.execute('INSERT INTO bill_items VALUES (?)', ['i2'])
    })

    expect(wrote).toHaveBeenCalledTimes(1)
  })

  it('says nothing about a transaction that rolled back', async () => {
    // Nothing was written, so there is nothing to tell — and a round carrying an
    // empty batch would still leave the far screen saying the tills just agreed.
    const wrote = vi.fn()
    const db = nudgingDriver(
      fake({ transaction: async () => { throw new Error('rolled back') } }),
      wrote,
    )

    await expect(db.transaction(async () => undefined)).rejects.toThrow('rolled back')
    expect(wrote).not.toHaveBeenCalled()
  })

  it('says nothing about a write that failed', async () => {
    const wrote = vi.fn()
    const db = nudgingDriver(
      fake({ execute: async () => { throw new Error('locked') } }),
      wrote,
    )

    await expect(db.execute('UPDATE products SET name = ?', ['x'])).rejects.toThrow('locked')
    expect(wrote).not.toHaveBeenCalled()
  })

  it('hands back what the driver underneath returned', async () => {
    // A wrapper that swallowed a row count would break every caller that reads it.
    const db = nudgingDriver(
      fake({ execute: async () => ({ changes: 7, lastInsertRowid: 3 }) }),
      () => undefined,
    )
    expect(await db.execute('DELETE FROM drafts')).toEqual({ changes: 7, lastInsertRowid: 3 })
  })

  it('passes the transaction budget through untouched', async () => {
    /* A merge asks for ninety seconds and a bill does not. Losing the option
       here would put every merge on the default and fail the long ones. */
    const seen: unknown[] = []
    const db = nudgingDriver(
      fake({ transaction: async (fn, opts) => { seen.push(opts); return fn(fake()) } }),
      () => undefined,
    )

    await db.transaction(async () => undefined, { budgetMs: 90_000 })
    expect(seen).toEqual([{ budgetMs: 90_000 }])
  })
})
