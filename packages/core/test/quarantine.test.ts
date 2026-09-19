import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { collectChanges, applyBatch } from '../src/services/sync.js'
import {
  quarantinedRecords, unreadQuarantineCount, acknowledgeQuarantine, discardQuarantined,
} from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import type { Row, SqlDriver } from '../src/db/driver.js'

/**
 * A record that cannot land, and everything behind it that can.
 *
 * Migration 038 carries the argument. What is asserted here is the behaviour a
 * shop depends on: the batch completes, the cursor is free to move, the record
 * is kept rather than lost, and the next round is not the same round.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

interface Till { id: string; db: SqlDriver; fx?: Fixture }
let a: Till
let b: Till

beforeEach(async () => {
  const fxa = await freshDb()
  a = { id: TILL_A, db: fxa.db, fx: fxa }
  b = { id: TILL_B, db: await emptyDb() }
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

async function as<T>(till: Till, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(till.id)
  try { return await fn() } finally { setDeviceId(before) }
}

const now = () => new Date().toISOString()

/** Everything A has, applied to B, as one round of `/offer` would. */
async function push(from: Till, to: Till) {
  const batch = await as(from, () => collectChanges(from.db, 0, 500, to.id))
  return as(to, () => applyBatch(to.db, batch, new Set()))
}

/**
 * The collision a two-till shop meets first: both counters price the same item
 * while out of touch. Two ids, and `UNIQUE (product_id, price_list_id,
 * sale_unit, min_qty)` will hold only one of them.
 */
async function bothPriceTheSameItem(): Promise<string> {
  const product = await makeProduct(a.db, { id: newId(), name: 'Rice 1kg' })
  const list = a.fx!.seed.priceListId
  for (const table of ['products', 'price_lists'] as const) {
    const id = table === 'products' ? product : list
    const row = await a.db.get<Row>(`SELECT * FROM "${table}" WHERE id = ?`, [id])
    const columns = Object.keys(row!)
    await b.db.execute(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')})
       VALUES (${columns.map(() => '?').join(',')})`,
      columns.map((c) => row![c]!),
    )
  }
  for (const [till, rate] of [[a, 9000], [b, 9500]] as const) {
    await till.db.execute(
      `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, created_at, updated_at)
       VALUES (?, ?, ?, 'NOS', 0, ?, ?, ?)`,
      [newId(), product, list, rate, now(), now()],
    )
  }
  return product
}

describe('a record that cannot be applied', () => {
  it('does not take the rest of the batch with it', async () => {
    await bothPriceTheSameItem()
    const innocent = await makeProduct(a.db, { name: 'Nothing wrong with this one' })

    const outcome = await push(a, b)

    expect(outcome.quarantined).toBe(1)
    expect(
      await b.db.get<Row>(`SELECT id FROM products WHERE id = ?`, [innocent]),
      'the product behind the poisoned record still arrived',
    ).toBeDefined()
  })

  it('is kept, with what SQLite said about it', async () => {
    await bothPriceTheSameItem()
    await push(a, b)

    const [held] = await quarantinedRecords(b.db)
    expect(held?.table).toBe('item_prices')
    expect(held?.peerDevice).toBe(TILL_A)
    expect(held?.reason, 'the constraint is the diagnosis').toContain('UNIQUE')
    expect(await unreadQuarantineCount(b.db)).toBe(1)
  })

  it('keeps the record itself, because nothing else will ever hold it', async () => {
    /* The cursor moves past it and the sending till prunes its feed entry, so
       this row is the only account of that row there will be. */
    await bothPriceTheSameItem()
    await push(a, b)

    const [held] = await quarantinedRecords(b.db)
    const record = JSON.parse(held!.record) as { table: string; row: Record<string, unknown> }
    expect(record.table).toBe('item_prices')
    expect(record.row['rate'], 'the price the other till actually holds').toBe(9000)
  })

  it('is one entry however many times it fails', async () => {
    await bothPriceTheSameItem()
    await push(a, b)
    await push(a, b)
    await push(a, b)

    expect(await unreadQuarantineCount(b.db)).toBe(1)
  })

  it('comes back unread when it fails again after somebody has looked', async () => {
    await bothPriceTheSameItem()
    await push(a, b)
    await acknowledgeQuarantine(b.db)
    expect(await unreadQuarantineCount(b.db)).toBe(0)

    await push(a, b)
    expect(
      await unreadQuarantineCount(b.db),
      'seeing it last week is not the same as seeing this',
    ).toBe(1)
  })

  it('can be forgotten once a person has put the shop right', async () => {
    await bothPriceTheSameItem()
    await push(a, b)

    const [held] = await quarantinedRecords(b.db)
    await discardQuarantined(b.db, held!.id)
    expect(await quarantinedRecords(b.db, { unreadOnly: false })).toHaveLength(0)
  })

  it('leaves a healthy batch untouched and unquarantined', async () => {
    await makeProduct(a.db, { name: 'An ordinary product' })
    const outcome = await push(a, b)

    expect(outcome.quarantined).toBe(0)
    expect(outcome.applied).toBeGreaterThan(0)
    expect(await unreadQuarantineCount(b.db)).toBe(0)
  })

  it('sets aside what depends on it rather than failing at the commit', async () => {
    /* A deferred foreign key is checked when the batch is whole, so a record
       pointing at one that did not land fails the COMMIT and takes everything
       with it — which is the stall this exists to prevent, arriving at the last
       possible moment instead of the first.

       Both tills have a product under the code `RICE1`, which is UNIQUE, so A's
       product cannot land on B. The unit that hangs off it must go with it. */
    const mine = await makeProduct(a.db, { id: newId(), name: 'Rice 1kg' })
    const theirs = await makeProduct(b.db, { id: newId(), name: 'Rice, a different one' })
    await a.db.execute(`UPDATE products SET code = 'RICE1' WHERE id = ?`, [mine])
    await b.db.execute(`UPDATE products SET code = 'RICE1' WHERE id = ?`, [theirs])

    await a.db.execute(
      `INSERT INTO product_units (id, product_id, sale_unit, base_units, created_at, updated_at)
       VALUES (?, ?, 'BOX', 120000, ?, ?)`,
      [newId(), mine, now(), now()],
    )

    const outcome = await push(a, b)

    const held = await quarantinedRecords(b.db, { unreadOnly: false })
    const byTable = new Map(held.map((h) => [h.table, h]))

    expect(byTable.get('products')?.reason, 'the product collided on its code').toContain('UNIQUE')
    expect(
      byTable.get('product_units')?.reason,
      'and the unit hanging off it was set aside rather than left to fail the commit',
    ).toContain('parent quarantined')
    expect(outcome.quarantined).toBe(2)

    // The point of all of it: the batch still committed.
    expect(
      await b.db.get<Row>(`SELECT id FROM products WHERE id = ?`, [theirs]),
      'B still has its own shop',
    ).toBeDefined()
  })
})
