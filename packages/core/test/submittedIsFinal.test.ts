import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import { DOCUMENT_TABLES, FROZEN } from '../src/integrity/docstatus.js'
import { fromUnits } from '../src/quantity.js'
import { rupees } from '../src/money.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * "Submitted is immutable", said by the database as well as the code (059).
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function submitted(): Promise<string> {
  const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  await fx.db.transaction((tx) => postMovement(tx, {
    productId: p, qtyChange: fromUnits(5), voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
  }))
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: p, qty: fromUnits(1) }], actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const paid = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
  })
  if (!paid.ok) throw new Error(paid.code)
  return draft.billId
}

describe('a submitted bill', () => {
  it('refuses a different total, however it is asked', async () => {
    const id = await submitted()
    await expect(fx.db.execute('UPDATE bills SET grand_total = 1 WHERE id = ?', [id])).rejects.toThrow(/final/)
    await expect(fx.db.execute(`UPDATE bills SET posting_date = '2020-01-01' WHERE id = ?`, [id])).rejects.toThrow(/final/)
  })

  it('refuses to go back to being a draft', async () => {
    const id = await submitted()
    await expect(fx.db.execute('UPDATE bills SET docstatus = 0 WHERE id = ?', [id])).rejects.toThrow(/final/)
  })

  it('can still be cancelled, which is the one move it has left', async () => {
    const id = await submitted()
    const cancelled = await cancelBill(fx.db, { billId: id, actorId: fx.adminId })
    expect(cancelled.ok).toBe(true)
    await expect(fx.db.execute('UPDATE bills SET docstatus = 1 WHERE id = ?', [id])).rejects.toThrow(/final/)
  })
})

describe('the guard on each document table', () => {
  it('covers every frozen column the table has, so the two lists cannot drift apart', async () => {
    for (const table of DOCUMENT_TABLES) {
      const trigger = await fx.db.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`, [`${table}_submitted_is_final`])
      expect(trigger, `${table} has a guard`).toBeDefined()
      const columns = (await fx.db.query<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name)
      for (const column of columns.filter((c) => FROZEN.has(c))) {
        expect(trigger!.sql, `${table}.${column} is held`).toContain(`NEW.${column} IS NOT OLD.${column}`)
      }
    }
  })
})
