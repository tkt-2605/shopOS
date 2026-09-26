import { describe, it, expect, afterEach } from 'vitest'
import { newId, observeId } from '../src/ids.js'
import { recomputeStock, postMovement } from '../src/services/stock.js'
import { fromUnits } from '../src/quantity.js'
import { rupees } from '../src/money.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Two tills holding the same ledger value it the same way.
 *
 * The ledger was replayed in `rowid` order, which is the order rows reached
 * *this* database. Rows made on another till arrive in whatever order sync
 * brings them, and moving-average valuation with a zero floor depends on
 * order, so two tills with identical ledgers disagreed about what the stock
 * was worth -- and the post-merge repair wrote each one's answer into its cache.
 */

const opened: Fixture[] = []
afterEach(async () => { for (const fx of opened.splice(0)) await fx.db.close() })

describe('newId', () => {
  it('only ever goes up in one process, however fast it is called', () => {
    const ids = Array.from({ length: 5000 }, () => newId())
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not follow an id stamped years ahead, which would drag every id after it there', () => {
    const farAhead = (Date.now() + 5 * 365 * 24 * 3600 * 1000).toString(16).padStart(12, '0')
    const plain = newId().replace(/-/g, '')
    const broken = `${farAhead.slice(0, 8)}-${farAhead.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`
    observeId(broken)
    expect(newId() < broken).toBe(true)
  })

  it('is still a version 7 id with the RFC variant', () => {
    for (let i = 0; i < 200; i++) {
      expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })
})

describe('the stock ledger replay', () => {
  it('gives one answer whichever order the rows arrived in', async () => {
    /* Order matters here: the sale overdraws, the value floors at zero, and
       the second delivery rebases it. Replayed the other way round, the same
       three movements are worth something else. */
    const moves = [
      { id: newId(), qty: 10, cost: rupees(5) },
      { id: newId(), qty: -15, cost: null },
      { id: newId(), qty: 10, cost: rupees(8) },
    ]

    const valueOn = async (arrival: typeof moves) => {
      const fx = await freshDb()
      opened.push(fx)
      const product = await makeProduct(fx.db, { id: 'p-same-on-both' })
      for (const m of arrival) {
        await fx.db.execute(
          `INSERT INTO stock_ledger (id, product_id, posting_date, qty_change, unit_cost, balance_qty,
                                     voucher_type, voucher_id, created_at)
           VALUES (?, ?, '2026-03-01', ?, ?, 0, 'opening', ?, '2026-03-01T10:00:00.000Z')`,
          [m.id, product, fromUnits(m.qty), m.cost, newId()],
        )
      }
      await recomputeStock(fx.db, { repair: true })
      return fx.db.get<{ qty_on_hand: number; stock_value: number }>(
        'SELECT qty_on_hand, stock_value FROM product_stock WHERE product_id = ?', [product],
      )
    }

    const here = await valueOn(moves)
    const there = await valueOn([moves[2]!, moves[0]!, moves[1]!])
    expect(there).toEqual(here)
  })

  it('keeps a sale after goods that came from a till whose clock runs ahead', async () => {
    /* The independent review's case. Ids are time-ordered, so a till an hour
       fast mints ids an hour into this till's future; a sale posted here
       afterwards sorted before them on replay, and the replay disagreed with
       the cache on a product nothing had gone wrong with. */
    const fx = await freshDb()
    opened.push(fx)
    const product = await makeProduct(fx.db)
    await fx.db.transaction((tx) => postMovement(tx, {
      productId: product, qtyChange: fromUnits(10), unitCost: rupees(100),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-03-01',
    }))

    const hourAhead = (Date.now() + 3_600_000).toString(16).padStart(12, '0')
    const plain = newId().replace(/-/g, '')
    const fast = `${hourAhead}${plain.slice(12)}`
    const fromTheFastTill = `${fast.slice(0, 8)}-${fast.slice(8, 12)}-${fast.slice(12, 16)}-${fast.slice(16, 20)}-${fast.slice(20)}`
    await fx.db.execute(
      `INSERT INTO stock_ledger (id, product_id, posting_date, qty_change, unit_cost, balance_qty,
                                 voucher_type, voucher_id, created_at)
       VALUES (?, ?, '2026-03-01', ?, ?, 0, 'opening', ?, '2026-03-01T11:00:00.000Z')`,
      [fromTheFastTill, product, fromUnits(10), rupees(200), newId()],
    )
    await recomputeStock(fx.db, { repair: true, productIds: [product] })   // what the merge does

    await fx.db.transaction((tx) => postMovement(tx, {
      productId: product, qtyChange: fromUnits(-10), voucherType: 'bill', voucherId: newId(), postingDate: '2026-03-01',
    }))

    expect(await recomputeStock(fx.db, { productIds: [product] })).toEqual([])
    const sale = await fx.db.get<{ id: string }>(`SELECT id FROM stock_ledger WHERE voucher_type = 'bill'`)
    expect(sale!.id > fromTheFastTill).toBe(true)
  })
})
