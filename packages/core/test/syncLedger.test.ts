import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { syncUntilDone, collectChanges, applyBatch, changedHere } from '../src/services/sync.js'
import type { SyncTransport } from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { MIGRATION_FILES, MIN_PEER_SCHEMA_VERSION } from '../src/db/migrationKinds.js'
import { getSetting } from '../src/services/bootstrap.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { cancelBill } from '../src/services/billing/cancel.js'
import { setSetting } from '../src/services/settings.js'
import { createSupplier } from '../src/services/suppliers.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { pruneFeed, feedHead } from '../src/services/changefeed.js'
import { postMissingGl, fillLedgerOnce } from '../src/services/ledger.js'
import { businessDate } from '../src/dates.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * The general ledger between tills.
 *
 * Found on the rerun after 0.2.1: the books were worked out again on every
 * till after every merge, and that raced the entries the other till had
 * posted. A till joining a shop after its feed was pruned is sent the shop
 * table by table -- bills and purchases before the stock ledger, the stock
 * ledger before the entries -- so it posted a purchase with no stock in it,
 * and when the real entries arrived under the same ids the shop's first till
 * refused them as edits of an append-only ledger. And two tills filling in the
 * same history wrote the same rows a moment apart, which the merge reported as
 * an edit being dropped, once for every line.
 */

const A = '1111aaaa-1111-4111-8111-111111111111'
const B = '2222bbbb-2222-4222-8222-222222222222'

interface Till { id: string; db: SqlDriver }

let fx: Fixture
let a: Till
let b: Till

beforeEach(async () => {
  fx = await freshDb()
  a = { id: A, db: fx.db }
  b = { id: B, db: await emptyDb() }
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

async function as<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(id)
  try { return await fn() } finally { setDeviceId(before) }
}

/** The far till in process, sending `limit` records a batch. */
function wire(peer: Till, me: Till, limit: number): SyncTransport {
  return {
    async hello() {
      const cursor = await peer.db.get<{ c: number }>(
        `SELECT their_cursor AS c FROM sync_peers WHERE device_id = ?`, [me.id])
      return {
        deviceId: peer.id, label: peer.id.slice(0, 4), schemaVersion: EXPECTED_SCHEMA_VERSION,
        shopId: await getSetting(peer.db, 'shop_id'), yourCursorWithThem: cursor?.c ?? 0,
      }
    },
    async fetch(since) { return as(peer.id, () => collectChanges(peer.db, since, limit, me.id)) },
    async offer(batch) {
      return as(peer.id, async () => {
        await applyBatch(peer.db, batch, await changedHere(peer.db, 0, batch.records))
        await peer.db.execute(
          `INSERT INTO sync_peers (device_id, their_cursor, created_at) VALUES (?, ?, ?)
           ON CONFLICT (device_id) DO UPDATE SET their_cursor = excluded.their_cursor`,
          [batch.fromDevice, batch.upTo, new Date().toISOString()])
        return { upTo: batch.upTo }
      })
    },
  }
}

const pull = (me: Till, from: Till, limit = 200) => as(me.id, () => syncUntilDone(me.db, wire(from, me, limit), 5000))

const books = (t: Till) => t.db.query(`SELECT id, account, debit, credit FROM gl_entries ORDER BY id`)
const setAside = (t: Till) => t.db.query(`SELECT table_name, row_id, reason FROM sync_quarantine`)
const complaints = (t: Till) => t.db.query(`SELECT table_name, row_id, explain FROM sync_conflicts`)

/** A sale on A, cancelled or not. */
async function sell(product: string, cancel = false): Promise<string> {
  return as(A, async () => {
    const d = await createBill(a.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(2) }], actorId: fx.adminId,
    })
    if (!d.ok) throw new Error(d.code)
    const p = await submitBill(a.db, { billId: d.billId, payments: [{ method: 'cash', amount: d.grandTotal }], actorId: fx.adminId })
    if (!p.ok) throw new Error(p.code)
    if (cancel) {
      const c = await cancelBill(a.db, { billId: d.billId, actorId: fx.adminId })
      if (!c.ok) throw new Error(c.code)
    }
    return d.billId
  })
}

/** A supplier's bill on A, so there is stock with a cost behind every sale. */
async function buy(): Promise<string> {
  return as(A, async () => {
    await setSetting(a.db, 'shop_state_code', '33')
    await setSetting(a.db, 'shop_tax_scheme', 'regular')
    const product = await makeProduct(a.db, { name: 'Rice', baseRate: rupees(1300), taxRateBp: 500 })
    const s = await createSupplier(a.db, { name: 'Mill', actorId: fx.adminId })
    if (!s.ok) throw new Error(s.code)
    const e = await createStockEntry(a.db, {
      entryType: 'purchase', supplierId: s.supplierId, postingDate: businessDate(),
      supplierInvoiceNo: 'INV-1', supplierInvoiceDate: businessDate(),
      lines: [{ productId: product, qty: fromUnits(10), unitCost: rupees(1000), taxRateBp: 500 }],
      actorId: fx.adminId,
    })
    if (!e.ok) throw new Error(e.code)
    const posted = await submitStockEntry(a.db, { entryId: e.entryId, actorId: fx.adminId })
    if (!posted.ok) throw new Error(posted.code)
    return product
  })
}

describe.each([1, 3, 200])('a sale and its cancellation, crossing %i records at a time', (limit) => {
  it('arrive with the entries the till that made them posted, and nothing set aside', async () => {
    await pull(b, a, limit)
    const product = await buy()
    const billId = await sell(product)
    await pull(b, a, limit)
    await as(A, () => cancelBill(a.db, { billId, actorId: fx.adminId }))
    await pull(b, a, limit)

    expect((await books(b)).length).toBeGreaterThan(0)
    expect(await books(b)).toEqual(await books(a))
    expect(await setAside(b)).toEqual([])
  })
})

describe.each([2, 3, 4, 6, 200])('a till joining after the feed was pruned, %i records at a time', (limit) => {
  it('takes the books the shop has rather than working out its own', async () => {
    const product = await buy()
    await sell(product)
    await sell(product, true)
    // Every peer has read it all, so it is gone, and a new till is sent the shop table by table.
    await as(A, async () => { await pruneFeed(a.db, await feedHead(a.db)) })

    await pull(b, a, limit)

    expect(await setAside(a)).toEqual([])
    expect(await setAside(b)).toEqual([])
    expect(await complaints(a)).toEqual([])
    expect(await books(b)).toEqual(await books(a))
  })
})

describe('two tills that both fill in the books for history they share', () => {
  it('write the same rows, and nobody is told an edit was dropped', async () => {
    const both = async () => { await pull(a, b); await pull(b, a) }
    await both()
    const product = await buy()
    await sell(product)
    await both()
    // Both as they were on 0.1.x: the history, and no books for it.
    for (const t of [a, b]) {
      await t.db.execute(`DROP TRIGGER gl_entries_is_append_only_del`)
      await t.db.execute(`DELETE FROM gl_entries`)
      await t.db.execute(`DELETE FROM change_feed WHERE table_name = 'gl_entries'`)
    }
    await as(A, () => postMissingGl(a.db))
    await new Promise((r) => setTimeout(r, 5)) // a moment apart, as two tills are
    await as(B, () => postMissingGl(b.db))
    await both()
    await both()

    expect(await complaints(a)).toEqual([])
    expect(await complaints(b)).toEqual([])
    expect(await books(b)).toEqual(await books(a))
  })
})

describe('filling in the history', () => {
  it('happens once for a database, and not on a later opening', async () => {
    const product = await buy()
    const billId = await sell(product)
    await a.db.execute(`DROP TRIGGER gl_entries_is_append_only_del`)
    await a.db.execute(`DELETE FROM gl_entries`)
    await a.db.execute(`UPDATE sync_state SET ledger_filled = 0`)

    const first = await fillLedgerOnce(a.db)
    expect(first?.posted).toBeGreaterThan(0)
    expect((await a.db.query(`SELECT 1 FROM gl_entries WHERE voucher_id = ?`, [billId])).length).toBeGreaterThan(0)
    expect(await fillLedgerOnce(a.db)).toBeNull()
  })

  it('is never needed after a merge, because no till that can sync is without a ledger', () => {
    /* The merge stopped filling in the books on this argument. If a breaking
       migration below the ledger were ever the last one, a till with no ledger
       could sync again and its documents would arrive with no entries. */
    const ledger = MIGRATION_FILES.find(([, file]) => file === '064_the_books.sql')![0]
    expect(MIN_PEER_SCHEMA_VERSION).toBeGreaterThanOrEqual(ledger)
  })
})
