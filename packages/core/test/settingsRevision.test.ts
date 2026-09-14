import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setSetting, getSetting, forgetSetting } from '../src/services/bootstrap.js'
import { setStockPolicy } from '../src/services/features.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * `settings` was the one mutable table with no revision on it.
 *
 * It holds the shop's name, its state code, the stock policy, the rounding rule
 * and every feature switch — all of which have to reach a second till — and it
 * was the only such table carrying neither `rev` nor `origin_id`. Migration 019
 * put a trigger on twenty tables and left this one out, which would have made it
 * the single special case in whatever merge ships.
 *
 * Not every row here is the shop's, though, and the ones that are not have been
 * moved out rather than given a revision.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const revOf = async (key: string) =>
  (await fx.db.get<{ rev: number }>(`SELECT rev FROM settings WHERE key = ?`, [key]))?.rev

describe('a setting that changed', () => {
  it('starts at one and rises each time it is written', async () => {
    // A key the bootstrap does not already write, so this starts from nothing.
    await setSetting(fx.db, 'receipt_footer', 'Thank you')
    expect(await revOf('receipt_footer')).toBe(1)

    await setSetting(fx.db, 'receipt_footer', 'Thank you, call again')
    expect(await revOf('receipt_footer')).toBe(2)

    await setSetting(fx.db, 'receipt_footer', 'Goods once sold')
    expect(await revOf('receipt_footer')).toBe(3)
  })

  it('rises when a service changes it, not only a bare statement', async () => {
    await setStockPolicy(fx.db, { actorId: fx.adminId }, 'block')
    const first = await revOf('stock_policy')
    expect(first).toBeGreaterThanOrEqual(1)

    await setStockPolicy(fx.db, { actorId: fx.adminId }, 'allow')
    expect(await revOf('stock_policy')).toBe(first! + 1)
  })

  /* One row per setting is what makes this work: two tills changing two
     different settings are not in conflict at all, and only the same setting
     changed twice is a disagreement someone has to lose. */
  it('leaves every other setting where it was', async () => {
    await setSetting(fx.db, 'receipt_footer', 'Thank you')
    await setSetting(fx.db, 'shop_address', '12 Big Street')

    await setSetting(fx.db, 'receipt_footer', 'Call again')

    expect(await revOf('receipt_footer')).toBe(2)
    expect(await revOf('shop_address')).toBe(1)
  })

  it('has a trigger, like every other table that carries a revision', async () => {
    const row = await fx.db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'bump_rev_settings'`,
    )
    expect(row?.name).toBe('bump_rev_settings')
  })
})

describe('a setting that was never the shop’s', () => {
  /* The printer plugged into this till, the command that carries its backup
     away, the folder it writes to, how its screen is set up. Sharing them means
     the second till prints on the first till's printer. */

  it('is gone from the shared table once forgotten', async () => {
    await setSetting(fx.db, 'thermal_printer', 'EPSON TM-T82')
    await forgetSetting(fx.db, 'thermal_printer')

    expect(await getSetting(fx.db, 'thermal_printer')).toBeNull()
  })

  it('is no trouble to forget twice', async () => {
    await forgetSetting(fx.db, 'backup_hook')
    await forgetSetting(fx.db, 'backup_hook')
    expect(await getSetting(fx.db, 'backup_hook')).toBeNull()
  })

  it('leaves the shop’s own settings untouched', async () => {
    await setSetting(fx.db, 'shop_name', 'TRT Stationery')
    await setSetting(fx.db, 'thermal_printer', 'EPSON TM-T82')

    await forgetSetting(fx.db, 'thermal_printer')

    expect(await getSetting(fx.db, 'shop_name')).toBe('TRT Stationery')
  })
})
