import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  syncWith, collectChanges, applyBatch, changedHere, type SyncTransport,
} from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { getSetting } from '../src/services/bootstrap.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement, currentStock } from '../src/services/stock.js'
import { listShortfalls, countShortfalls } from '../src/repos/shortfalls.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { paise } from '../src/money.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Two tills, one item left, and both of them sell it.
 *
 * The last thing owed by `docs/multi-device.md`, and the one merging genuinely
 * cannot fix: the goods are gone. Two people walked out with the same last unit
 * and one of them is going home without it, and no rule about revisions changes
 * that.
 *
 * What the product can do is **notice**, and say which item it happened to. That
 * turned out to be two separate failures:
 *
 *  * `product_stock` is a cache of the ledger and does not replicate. Nothing
 *    recomputed it after a merge, so a till that took in the other's sales kept
 *    its old figures — each till still said zero, nothing was below zero, and
 *    "Counts that need fixing" stayed empty.
 *  * `balance_qty` is stamped per row by whichever till wrote it, and two tills
 *    that merged never shared a running total. Each sale was legitimately the
 *    last one at the moment it was made, so no row records going under, and the
 *    columns that explain a shortfall came back blank exactly when a second till
 *    caused it.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

interface Till {
  id: string
  db: SqlDriver
  fx: Fixture
  /** Its own counter. Two tills on one counter mint the same invoice numbers. */
  registerId: string
}

let a: Till
let b: Till

beforeEach(async () => {
  const fx = await freshDb()
  a = { id: TILL_A, db: fx.db, fx, registerId: fx.seed.registerId }
  b = { id: TILL_B, db: await emptyDb(), fx, registerId: '' }
  await giveSecondTillItsOwnCounter()
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

function wireTo(peer: Till, me: Till): SyncTransport {
  return {
    async hello() {
      const row = await peer.db.get<{ c: number }>(
        `SELECT their_cursor AS c FROM sync_peers WHERE device_id = ?`, [me.id],
      )
      return {
        deviceId: peer.id,
        label: peer.id.slice(0, 4),
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        shopId: await getSetting(peer.db, 'shop_id'),
        registerId: peer.registerId === '' ? null : peer.registerId,
        yourCursorWithThem: row?.c ?? 0,
      }
    },
    fetch: (since, limit) => as(peer, () => collectChanges(peer.db, since, limit)),
    async offer(batch) {
      return as(peer, async () => {
        await applyBatch(peer.db, batch, await changedHere(peer.db, 0, batch.records))
        await peer.db.execute(
          `INSERT INTO sync_peers (device_id, their_cursor, created_at) VALUES (?, ?, ?)
           ON CONFLICT (device_id) DO UPDATE SET their_cursor = excluded.their_cursor`,
          [batch.fromDevice, batch.upTo, new Date().toISOString()],
        )
        return { upTo: batch.upTo }
      })
    },
  }
}

async function bothWays() {
  const first = await as(a, () => syncWith(a.db, wireTo(b, a), a.registerId))
  const second = await as(b, () => syncWith(b.db, wireTo(a, b), b.registerId || null))
  if (!first.ok) throw new Error(`till A refused: ${first.code}`)
  if (!second.ok) throw new Error(`till B refused: ${second.code}`)
}

/**
 * The second counter, which is what a second till actually sits at.
 *
 * Before any sync, because a till that has never been told which counter it is
 * falls back to the first one in the list — the other till's — and `syncWith`
 * now refuses that outright rather than letting the two mint invoice numbers
 * from one series and collide on the first bill to cross.
 *
 * Both tills on one counter is not a smaller version of two tills. It is a
 * broken one, and this is the setup a shop has to have.
 */
async function giveSecondTillItsOwnCounter(): Promise<void> {
  if (b.registerId !== '') return
  const id = newId()
  const now = new Date().toISOString()
  for (const till of [a, b]) {
    await till.db.execute(
      `INSERT INTO registers (id, name, prefix, is_active, created_at, updated_at)
       VALUES (?, 'Back counter', 'BC', 1, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [id, now, now],
    )
  }
  b.registerId = id
}

/** A sale that actually moves the ledger, which is what a submitted bill is. */
async function sell(till: Till, productId: string, units: number): Promise<void> {
  await as(till, async () => {
    const made = await createBill(till.db, {
      registerId: till.registerId,
      lines: [{ productId, qty: fromUnits(units) }],
      actorId: till.fx.adminId,
    })
    if (!made.ok) throw new Error(made.code)
    const done = await submitBill(till.db, {
      billId: made.billId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
      actorId: till.fx.adminId,
    })
    if (!done.ok) throw new Error(done.code)
  })
}

describe('two tills selling the same last one', () => {
  it('leaves the shop one short, and says so', async () => {
    // One unit on the shelf, known to both tills.
    const productId = await as(a, () => makeProduct(a.db, { name: 'Last notebook' }))
    await as(a, () => postMovement(a.db, {
      productId, qtyChange: fromUnits(1), unitCost: paise(5000),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    }))
    await bothWays()

    expect(toUnits(await currentStock(a.db, productId))).toBe(1)
    expect(toUnits(await currentStock(b.db, productId))).toBe(1)

    // Both counters sell it, neither able to see the other.
    await sell(a, productId, 1)
    await sell(b, productId, 1)

    // Each is at zero and neither is wrong on its own.
    expect(toUnits(await currentStock(a.db, productId))).toBe(0)
    expect(toUnits(await currentStock(b.db, productId))).toBe(0)
    expect(await countShortfalls(a.db)).toBe(0)

    await bothWays()

    // Put together, the shop is one short — and both tills agree that it is.
    expect(toUnits(await currentStock(a.db, productId))).toBe(-1)
    expect(toUnits(await currentStock(b.db, productId))).toBe(-1)
    expect(await countShortfalls(a.db)).toBe(1)
    expect(await countShortfalls(b.db)).toBe(1)
  })

  it('names the item, the shortfall and the day it happened', async () => {
    const productId = await as(a, () => makeProduct(a.db, { name: 'Last notebook' }))
    await as(a, () => postMovement(a.db, {
      productId, qtyChange: fromUnits(1), unitCost: paise(5000),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    }))
    await bothWays()

    await sell(a, productId, 1)
    await sell(b, productId, 1)
    await bothWays()

    const { rows } = await listShortfalls(a.db)
    expect(rows).toHaveLength(1)
    const short = rows[0]!
    expect(short.name).toBe('Last notebook')
    expect(toUnits(short.onHand)).toBe(-1)

    /* The part that used to come back blank. No single ledger row ever recorded
       going under, because at the moment each sale was made it was the last one
       — so these are inferred from the shortfall rather than read off a row. */
    expect(toUnits(short.soldShort)).toBe(1)
    expect(short.shortSince).not.toBeNull()
  })

  it('stops complaining once the count is put right', async () => {
    const productId = await as(a, () => makeProduct(a.db, { name: 'Last notebook' }))
    await as(a, () => postMovement(a.db, {
      productId, qtyChange: fromUnits(1), unitCost: paise(5000),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    }))
    await bothWays()

    await sell(a, productId, 1)
    await sell(b, productId, 1)
    await bothWays()
    expect(await countShortfalls(a.db)).toBe(1)

    // The missing one is found, or written off, or a delivery is entered.
    await as(a, () => postMovement(a.db, {
      productId, qtyChange: fromUnits(1), unitCost: paise(5000),
      voucherType: 'adjustment', voucherId: newId(), postingDate: '2026-01-05',
    }))

    expect(await countShortfalls(a.db)).toBe(0)
    await bothWays()
    // And the other till is told too, rather than being left with the complaint.
    expect(await countShortfalls(b.db)).toBe(0)
  })
})

describe('two tills that were put on one counter', () => {
  it('is refused, rather than colliding on the first bill to cross', async () => {
    /* They mint invoice numbers from the same series, so the first bill that
       crosses fails on `bills.doc_no` and the sync dies on a UNIQUE constraint
       with nothing saying why. This is also what a second till gets by default:
       a machine that has never been told which counter it is falls back to the
       first active one, which is the other till's. */
    // Set up properly first, so B genuinely holds the counter it then claims.
    await bothWays()
    b.registerId = a.registerId

    const round = await as(b, () => syncWith(b.db, wireTo(a, b), b.registerId))

    expect(round.ok).toBe(false)
    if (!round.ok) {
      expect(round.code).toBe('SAME_REGISTER')
      if (round.code === 'SAME_REGISTER') expect(round.registerId).toBe(a.registerId)
    }
  })

  it('works the moment each is on its own counter', async () => {
    const round = await as(b, () => syncWith(b.db, wireTo(a, b), b.registerId))
    expect(round.ok).toBe(true)
  })
})

describe('the stock cache after a merge', () => {
  it('is rebuilt, rather than left saying what it said before', async () => {
    /* `product_stock` does not replicate — it is derived — and `NOT_REPLICATED`
       said "a merge recomputes it" while nothing did. A till that took in the
       other's sales kept its old figures until somebody happened to open
       Inventory. */
    const productId = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await as(a, () => postMovement(a.db, {
      productId, qtyChange: fromUnits(10), unitCost: paise(5000),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    }))
    await bothWays()

    await sell(a, productId, 4)
    await bothWays()

    expect(toUnits(await currentStock(b.db, productId))).toBe(6)
  })

  it('does not rebuild when nothing that touches stock arrived', async () => {
    // Replaying the whole ledger on a batch of price edits would be waste.
    const productId = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    await as(a, () => a.db.execute(
      `UPDATE products SET name = ? WHERE id = ?`, ['Renamed', productId],
    ))
    await bothWays()

    const row = await b.db.get<{ name: string }>(
      `SELECT name FROM products WHERE id = ?`, [productId],
    )
    expect(row?.name).toBe('Renamed')
  })
})
