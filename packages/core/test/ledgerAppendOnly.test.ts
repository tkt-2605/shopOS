import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { postMovement } from '../src/services/stock.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * "Ledgers are append-only", said by the database as well as the code (052).
 */

let fx: Fixture
let rowId: string

beforeEach(async () => {
  fx = await freshDb()
  const p = await makeProduct(fx.db)
  await fx.db.transaction((tx) => postMovement(tx, {
    productId: p, qtyChange: fromUnits(5), voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
  }))
  rowId = (await fx.db.get<{ id: string }>('SELECT id FROM stock_ledger'))!.id
})
afterEach(async () => { await fx.db.close() })

describe('the stock ledger', () => {
  it('refuses to have a movement rewritten', async () => {
    await expect(fx.db.execute('UPDATE stock_ledger SET qty_change = ? WHERE id = ?', [fromUnits(50), rowId]))
      .rejects.toThrow(/append-only/)
    await expect(fx.db.execute('UPDATE stock_ledger SET unit_cost = 1 WHERE id = ?', [rowId]))
      .rejects.toThrow(/append-only/)
  })

  it('refuses to have a movement deleted', async () => {
    await expect(fx.db.execute('DELETE FROM stock_ledger WHERE id = ?', [rowId])).rejects.toThrow(/append-only/)
  })

  it('lets the running balance differ, because each till keeps its own', async () => {
    await fx.db.execute('UPDATE stock_ledger SET balance_qty = ? WHERE id = ?', [fromUnits(9), rowId])
    const row = await fx.db.get<{ balance_qty: number }>('SELECT balance_qty FROM stock_ledger WHERE id = ?', [rowId])
    expect(row?.balance_qty).toBe(fromUnits(9))
  })
})
