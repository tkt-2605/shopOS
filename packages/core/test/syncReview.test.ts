import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { syncWith, syncUntilDone, collectChanges, applyBatch } from '../src/services/sync.js'
import { changesSince, seedFeedWithEverything } from '../src/services/changefeed.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import type { Row, SqlDriver } from '../src/db/driver.js'
import type { SyncTransport, PeerHello } from '../src/services/sync.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { getSetting } from '../src/services/bootstrap.js'
import { handleOffer } from '../src/services/syncServer.js'

/**
 * A review pass, and then the record of it.
 *
 * Every test in here was written to FAIL. Each one asserts a behaviour the
 * code's own comments already claimed, and the failure was the finding — ten of
 * them, from a merge that could not be unstuck to a catch-up that stopped with
 * hundreds of rows queued and told the screen the tills agreed.
 *
 * All ten pass now, and the file stays. An earlier note on it said to delete it
 * once the findings were closed, which is exactly backwards: a defect that has
 * been fixed and has no test is a defect waiting to be reintroduced by somebody
 * who does not know it was ever there. What each of these is worth is the
 * comment above it, which says what went wrong and why the fix is the fix.
 *
 * The migrations carry the same arguments at length — 038 through 042 — and the
 * convergence harness in `tools/virtual-till/test/converges.test.ts` is what
 * asks the general question these ten ask specifically.
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

/** One push, exactly as the answering side does it. */
async function push(from: Till, to: Till): Promise<void> {
  const batch = await as(from, () => collectChanges(from.db, 0, 500, to.id))
  await as(to, () => applyBatch(to.db, batch, new Set()))
}

const now = () => new Date().toISOString()

/** The same product, on both tills, so the two can disagree about it. */
async function cloneRow(from: Till, to: Till, table: string, id: string): Promise<void> {
  const row = await from.db.get<Row>(`SELECT * FROM "${table}" WHERE id = ?`, [id])
  const columns = Object.keys(row!)
  await to.db.execute(
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')})
     VALUES (${columns.map(() => '?').join(',')})`,
    columns.map((c) => row![c]!),
  )
}

describe('1. a UNIQUE column that is not the primary key', () => {
  it('does not wedge a shop when two tills price the same item', async () => {
    /* The likeliest one in a working shop: the same product, the same price
       list, priced at both counters while they are out of touch. Two ids, one
       UNIQUE (product_id, price_list_id, sale_unit, min_qty). */
    const product = await makeProduct(a.db, { id: newId(), name: 'Rice 1kg' })
    await cloneRow(a, b, 'products', product)
    const list = a.fx!.seed.priceListId
    await cloneRow(a, b, 'price_lists', list)

    for (const [till, rate] of [[a, 9000], [b, 9500]] as const) {
      await till.db.execute(
        `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, created_at, updated_at)
         VALUES (?, ?, ?, 'NOS', 0, ?, ?, ?)`,
        [newId(), product, list, rate, now(), now()],
      )
    }

    await expect(push(a, b)).resolves.toBeUndefined()
  })

  it('is not stuck in the same place on every round afterwards', async () => {
    const product = await makeProduct(a.db, { id: newId(), name: 'Rice 1kg' })
    await cloneRow(a, b, 'products', product)
    const list = a.fx!.seed.priceListId
    await cloneRow(a, b, 'price_lists', list)
    for (const [till, rate] of [[a, 9000], [b, 9500]] as const) {
      await till.db.execute(
        `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, created_at, updated_at)
         VALUES (?, ?, ?, 'NOS', 0, ?, ?, ?)`,
        [newId(), product, list, rate, now(), now()],
      )
    }

    await push(a, b).catch(() => undefined)
    // Nothing retries, nothing quarantines: the next round is the same round.
    await expect(push(a, b)).resolves.toBeUndefined()
  })

  it('does not wedge a shop when two tills scan one barcode onto two products', async () => {
    const pa = await makeProduct(a.db, { name: 'Pen' })
    const pb = await makeProduct(b.db, { name: 'Pencil' })
    for (const [till, product] of [[a, pa], [b, pb]] as const) {
      await till.db.execute(
        `INSERT INTO product_barcodes (id, product_id, barcode, is_primary, created_at)
         VALUES (?, ?, '8901234500011', 1, ?)`,
        [newId(), product, now()],
      )
    }

    await expect(push(a, b)).resolves.toBeUndefined()
  })

  it('leaves the rest of the batch applied when one record cannot land', async () => {
    /* The other half of the same finding: one poisoned record takes the whole
       batch with it, so a day of bills behind it never arrives either. */
    const pa = await makeProduct(a.db, { name: 'Pen' })
    const pb = await makeProduct(b.db, { name: 'Pencil' })
    for (const [till, product] of [[a, pa], [b, pb]] as const) {
      await till.db.execute(
        `INSERT INTO product_barcodes (id, product_id, barcode, is_primary, created_at)
         VALUES (?, ?, '8901234500011', 1, ?)`,
        [newId(), product, now()],
      )
    }
    const good = await makeProduct(a.db, { name: 'A product with nothing wrong with it' })

    await push(a, b).catch(() => undefined)

    const landed = await b.db.get<Row>(`SELECT id FROM products WHERE id = ?`, [good])
    expect(landed, 'the innocent product arrived').toBeDefined()
  })
})

describe('2. a delete that meets a later edit', () => {
  it('carries the deleted revision, so decideDeletion can tell the two apart', async () => {
    const product = await makeProduct(a.db, { name: 'Gone' })
    await a.db.execute(`DELETE FROM products WHERE id = ?`, [product])

    const batch = await as(a, () => collectChanges(a.db, 0, 500, b.id))
    const record = batch.records.find((r) => r.rowId === product)

    expect(record?.op).toBe('delete')
    /* merge.ts: "the transport can only tell those apart with the revision the
       deleting side last saw". Nothing puts one on the wire. */
    expect(record?.row, 'a delete record carries the revision it deleted').not.toBeNull()
  })

  it('brings the row back when the other till changed it afterwards', async () => {
    const product = await makeProduct(a.db, { id: newId(), name: 'Contested' })
    const row = await a.db.get<Row>(`SELECT * FROM products WHERE id = ?`, [product])
    const columns = Object.keys(row!)
    await b.db.execute(
      `INSERT INTO products (${columns.map((c) => `"${c}"`).join(',')})
       VALUES (${columns.map(() => '?').join(',')})`,
      columns.map((c) => row![c]!),
    )

    // B edits it, so B's copy is at a higher revision than the one A deleted.
    await b.db.execute(
      `UPDATE products SET name = 'Contested, and wanted', updated_at = ? WHERE id = ?`,
      [now(), product],
    )
    await a.db.execute(`DELETE FROM products WHERE id = ?`, [product])

    await push(a, b)

    const survived = await b.db.get<Row>(`SELECT name FROM products WHERE id = ?`, [product])
    expect(survived, 'the later edit brought it back').toBeDefined()
  })
})

describe('3. a merge must not raise the revision of what it applied', () => {
  it('leaves the applied row at the revision it arrived with', async () => {
    /* 022: "bumping it here would make this copy look newer than the machine
       the change came from". The bump_rev triggers from 019 carry no
       sync_state.applying guard, so it does. */
    const product = await makeProduct(a.db, { id: newId(), name: 'Here' })
    const row = await a.db.get<Row>(`SELECT * FROM products WHERE id = ?`, [product])
    const columns = Object.keys(row!)
    await b.db.execute(
      `INSERT INTO products (${columns.map((c) => `"${c}"`).join(',')})
       VALUES (${columns.map(() => '?').join(',')})`,
      columns.map((c) => row![c]!),
    )

    // Both edit it once, out of touch: same rev on both, different content.
    await a.db.execute(
      `UPDATE products SET name = 'A calls it this', updated_at = ? WHERE id = ?`,
      ['2026-09-18T10:00:00.000Z', product],
    )
    await b.db.execute(
      `UPDATE products SET name = 'B calls it that', updated_at = ? WHERE id = ?`,
      ['2026-09-18T09:00:00.000Z', product],
    )

    const mine = await a.db.get<{ rev: number }>(`SELECT rev FROM products WHERE id = ?`, [product])
    await push(a, b)

    const theirs = await b.db.get<{ rev: number; name: string }>(
      `SELECT rev, name FROM products WHERE id = ?`, [product],
    )
    expect(theirs?.name, 'A won, on the later timestamp').toBe('A calls it this')
    expect(theirs?.rev, 'and B holds it at the revision A wrote').toBe(mine?.rev)
  })
})

describe('4. the cursor the answering side counts conflicts against', () => {
  it('is the peer progress through our feed, not ours through theirs', async () => {
    /* `handleOffer` asks `changedHere` what this till has changed lately, so it
       can tell a clash from an ordinary arrival. It was handed `their_cursor`,
       which is a sequence number in the *other* till's feed. The two run away
       from each other the moment one counter is busier than the other — the feed
       is a set, so an edit replaces an entry and still burns a seq — and a
       `their_cursor` above this till's own head makes `changedHere` answer
       "nothing", so every genuine clash is applied in silence. */
    const product = await as(a, () => makeProduct(a.db, { id: newId(), name: 'Both of us' }))
    await cloneRow(a, b, 'products', product)

    // Both edit it while out of touch. A's is later, so A's must win — and B
    // must be told that its own edit was the one dropped.
    await b.db.execute(
      `UPDATE products SET name = 'B calls it that', updated_at = ? WHERE id = ?`,
      ['2026-09-18T09:00:00.000Z', product],
    )
    await a.db.execute(
      `UPDATE products SET name = 'A calls it this', updated_at = ? WHERE id = ?`,
      ['2026-09-18T10:00:00.000Z', product],
    )

    /* B is the quiet counter and has read a long way into A's busy feed. This is
       the ordinary state of a shop, not a contrivance: it is what "the back
       office has been idle all morning" looks like in two columns. */
    await b.db.execute(
      `INSERT INTO sync_peers (device_id, label, their_cursor, my_cursor, created_at)
       VALUES (?, 'A', 500, 0, ?)`,
      [TILL_A, now()],
    )

    const batch = await as(a, () => collectChanges(a.db, 0, 500, TILL_B))
    await as(b, () => handleOffer(
      b.db,
      { path: '/offer', body: JSON.stringify(batch), auth: null },
      TILL_A,
    ))

    expect(
      await b.db.get<Row>(`SELECT name FROM products WHERE id = ?`, [product]),
      'A won on the later timestamp',
    ).toMatchObject({ name: 'A calls it this' })

    const [logged] = await b.db.query<{ table_name: string; row_id: string }>(
      `SELECT table_name, row_id FROM sync_conflicts`,
    )
    expect(
      logged,
      'and B recorded that an edit of its own went, which is what this table is for',
    ).toMatchObject({ table_name: 'products', row_id: product })
  })
})

describe('6. a catch-up that finds a round of rows it already has', () => {
  it('keeps going rather than reporting that the tills agree', async () => {
    /* `seedFeedWithEverything` runs every time a till joins, and puts the whole
       shop back in the feed for *every* peer. A peer that already holds those
       rows applies none of them -- identical rows write nothing, correctly --
       so `syncUntilDone` sees received 0, sent 0 and stops with `more: false`
       while hundreds of records are still queued behind the cursor. */
    for (let i = 0; i < 450; i += 1) {
      await makeProduct(a.db, { id: newId(), name: `Product ${i}` })
    }

    const transport: SyncTransport = {
      async hello(): Promise<PeerHello> {
        const row = await a.db.get<{ c: number }>(
          `SELECT their_cursor AS c FROM sync_peers WHERE device_id = ?`, [TILL_B],
        )
        return {
          deviceId: TILL_A, label: 'A', schemaVersion: EXPECTED_SCHEMA_VERSION,
          minPeerSchema: 1, shopId: await getSetting(a.db, 'shop_id'),
          registerId: null, yourCursorWithThem: row?.c ?? 0,
        }
      },
      fetch: (since, limit) => as(a, () => collectChanges(a.db, since, limit, TILL_B)),
      async offer(batch) {
        await as(a, () => applyBatch(a.db, batch, new Set()))
        await a.db.execute(
          `INSERT INTO sync_peers (device_id, their_cursor, created_at) VALUES (?, ?, ?)
           ON CONFLICT (device_id) DO UPDATE SET their_cursor = excluded.their_cursor`,
          [batch.fromDevice, batch.upTo, now()],
        )
        return { upTo: batch.upTo }
      },
    }

    // First, the ordinary catch-up: B takes the whole shop. This works.
    await as(b, () => syncUntilDone(b.db, transport, 50, null))

    /* Then a third till joins A, so `letThemIn` re-seeds the feed and every row
       in the shop is dirty again for B as well -- which is deliberate, and
       documented as costing "bandwidth on a LAN, once". B already holds every
       one of them identically, so it applies none of them. */
    await a.db.execute(`DELETE FROM change_feed`) // pruneAcknowledged, after a round
    await as(a, () => seedFeedWithEverything(a.db))
    await as(b, () => syncUntilDone(b.db, transport, 50, null))

    const [peer] = await b.db.query<{ their_cursor: number }>(
      `SELECT their_cursor FROM sync_peers WHERE device_id = ?`, [TILL_A],
    )
    const left = await changesSince(a.db, peer!.their_cursor, 5000, TILL_B)
    expect(left.length, 'nothing is left queued once the catch-up says it is done').toBe(0)
  })
})

describe('5. a peer that acknowledges more than it was sent', () => {
  it('cannot make this till skip changes it never sent', async () => {
    await makeProduct(a.db, { name: 'First' })

    const liar: SyncTransport = {
      async hello(): Promise<PeerHello> {
        return {
          deviceId: TILL_B, label: 'B', schemaVersion: EXPECTED_SCHEMA_VERSION,
          minPeerSchema: 1, shopId: await getSetting(a.db, 'shop_id'),
          registerId: null, yourCursorWithThem: 0,
        }
      },
      async fetch() {
        return {
          fromDevice: TILL_B, schemaVersion: EXPECTED_SCHEMA_VERSION,
          records: [], upTo: 0, complete: true,
        }
      },
      // Whatever it is handed, it claims to have taken everything, for ever.
      async offer() { return { upTo: 1_000_000 } },
    }

    await as(a, () => syncWith(a.db, liar, null))

    // Something written afterwards must still be sent.
    await makeProduct(a.db, { name: 'Second, written after the lie' })
    const [row] = await a.db.query<{ my_cursor: number }>(
      `SELECT my_cursor FROM sync_peers WHERE device_id = ?`, [TILL_B],
    )
    const head = await changesSince(a.db, row!.my_cursor, 500, TILL_B)
    expect(head.length, 'the later change is still queued for that till').toBeGreaterThan(0)
  })
})
