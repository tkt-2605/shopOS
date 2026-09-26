import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  collectChanges, applyBatch, quarantinedRecords,
} from '../src/services/sync.js'
import { feedHead } from '../src/services/changefeed.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct } from './helpers.js'
import type { ChangeBatch } from '../src/domain/replicaShape.js'
import type { Row, SqlDriver } from '../src/db/driver.js'

/**
 * A record whose parent is not here yet, and a record that was set aside.
 *
 * The feed is a set, so editing a row moves its entry to the end. Add a product
 * to a category and then rename the category, and the product's entry now sits
 * *before* the category's -- and a batch boundary between them hands the other
 * till a product pointing at nothing. The foreign key is deferred to COMMIT,
 * where a savepoint cannot catch it, so this used to fail both passes, set
 * nothing aside and leave the cursor where it was: the next round built the
 * identical batch, and the two tills were wedged for good.
 *
 * And a record once set aside used to stay there, because the cursor had moved
 * past it and nothing would ever offer it again.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

interface Till { id: string; db: SqlDriver }
let a: Till
let b: Till

beforeEach(async () => {
  a = { id: TILL_A, db: (await freshDb()).db }
  b = { id: TILL_B, db: await emptyDb() }
  // B holds the shop as it stood, so each test starts from two tills that agree.
  await deliver(await as(a, () => collectChanges(a.db, 0, 5000, b.id)))
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

function deliver(batch: ChangeBatch) {
  return as(b, () => applyBatch(b.db, batch, new Set()))
}

const now = () => new Date().toISOString()

/** A category, a product in it, and then the category renamed. */
async function productBeforeItsCategory(): Promise<{ category: string; product: string; from: number }> {
  const from = await feedHead(a.db)
  const category = newId()
  await a.db.execute(
    `INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, 'Rice', ?, ?)`,
    [category, now(), now()],
  )
  const product = await makeProduct(a.db, { name: 'Ponni rice 25kg' })
  await a.db.execute(`UPDATE products SET category_id = ? WHERE id = ?`, [category, product])
  await a.db.execute(`UPDATE categories SET name = 'Rice and grains' WHERE id = ?`, [category])
  return { category, product, from }
}

const has = async (db: SqlDriver, table: string, id: string) =>
  (await db.get<Row>(`SELECT id FROM "${table}" WHERE id = ?`, [id])) !== undefined

describe('a record whose parent is in a later batch', () => {
  it('is set aside, and the batch it came in still commits', async () => {
    const { category, product, from } = await productBeforeItsCategory()
    const first = await as(a, () => collectChanges(a.db, from, 1, b.id))
    expect(first.records.map((r) => r.table), 'the boundary falls between them').toEqual(['products'])

    const outcome = await deliver(first)

    expect(outcome.quarantined).toBe(1)
    expect(await has(b.db, 'products', product)).toBe(false)
    expect(await has(b.db, 'categories', category)).toBe(false)
    const [held] = await quarantinedRecords(b.db, { unreadOnly: false })
    expect(held?.table).toBe('products')
    expect(held?.reason).toContain('waiting for categories')
  })

  it('lands by itself when the parent arrives', async () => {
    const { category, product, from } = await productBeforeItsCategory()
    const first = await as(a, () => collectChanges(a.db, from, 1, b.id))
    await deliver(first)

    const rest = await as(a, () => collectChanges(a.db, first.upTo, 500, b.id))
    await deliver(rest)

    expect(await has(b.db, 'categories', category)).toBe(true)
    expect(await has(b.db, 'products', product), 'the product came out of quarantine').toBe(true)
    expect(await quarantinedRecords(b.db, { unreadOnly: false })).toHaveLength(0)
  })

  it('does not stop a catch-up taken one record at a time', async () => {
    const { category, product, from } = await productBeforeItsCategory()
    const more = await makeProduct(a.db, { name: 'Something after it all' })

    let cursor = from
    for (let round = 0; round < 20; round += 1) {
      const batch = await as(a, () => collectChanges(a.db, cursor, 1, b.id))
      if (batch.records.length === 0) break
      await deliver(batch)
      cursor = batch.upTo
    }

    for (const [table, id] of [['categories', category], ['products', product], ['products', more]] as const) {
      expect(await has(b.db, table, id), `${table} ${id}`).toBe(true)
    }
    expect(await quarantinedRecords(b.db, { unreadOnly: false })).toHaveLength(0)
  })
})

describe('a record that was set aside', () => {
  /** Two logins called ravi, made on two tills apart. `users.username` is UNIQUE. */
  async function twoRavis(): Promise<{ theirs: string; mine: string }> {
    const [role] = await a.db.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`)
    const theirs = newId()
    const mine = newId()
    await a.db.execute(
      `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
       VALUES (?, 'ravi', 'Ravi at the front', ?, 'x', ?, ?)`,
      [theirs, role!.id, now(), now()],
    )
    await b.db.execute(
      `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
       VALUES (?, 'ravi', 'Ravi at the back', ?, 'x', ?, ?)`,
      [mine, role!.id, now(), now()],
    )
    return { theirs, mine }
  }

  it('lands on the next sync once a person has fixed the clash, with nothing arriving', async () => {
    const from = await feedHead(a.db)
    const { theirs, mine } = await twoRavis()
    await deliver(await as(a, () => collectChanges(a.db, from, 500, b.id)))
    const [held] = await quarantinedRecords(b.db)
    expect(held?.reason).toContain('same username')

    // The screen's advice, taken: rename one, then sync again.
    await b.db.execute(`UPDATE users SET username = 'ravi.b' WHERE id = ?`, [mine])
    const head = await feedHead(a.db)
    const empty = await as(a, () => collectChanges(a.db, head, 500, b.id))
    expect(empty.records).toHaveLength(0)
    await deliver(empty)

    expect(await has(b.db, 'users', theirs), 'the other till\'s ravi is here now').toBe(true)
    expect(await quarantinedRecords(b.db, { unreadOnly: false })).toHaveLength(0)
  })

  it('stays set aside, untouched, while the clash stands', async () => {
    const from = await feedHead(a.db)
    await twoRavis()
    await deliver(await as(a, () => collectChanges(a.db, from, 500, b.id)))
    const before = await quarantinedRecords(b.db, { unreadOnly: false })

    await makeProduct(a.db, { name: 'An unrelated product' })
    const outcome = await deliver(await as(a, () => collectChanges(a.db, from, 500, b.id)))

    expect(outcome.quarantined).toBe(1)
    const after = await quarantinedRecords(b.db, { unreadOnly: false })
    expect(after.map((h) => h.rowId)).toEqual(before.map((h) => h.rowId))
  })
})

describe('a delete of a row something here still points at', () => {
  it('is set aside rather than failing the commit', async () => {
    const category = newId()
    await a.db.execute(
      `INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, 'Oils', ?, ?)`,
      [category, now(), now()],
    )
    await deliver(await as(a, () => collectChanges(a.db, 0, 5000, b.id)))
    // B files a product under it while A, apart, removes the category.
    const product = await makeProduct(b.db, { name: 'Groundnut oil 1L' })
    await b.db.execute(`UPDATE products SET category_id = ? WHERE id = ?`, [category, product])

    const gone: ChangeBatch = {
      fromDevice: a.id, schemaVersion: 60, upTo: 1, complete: true,
      records: [{ table: 'categories', rowId: category, op: 'delete', row: { rev: null } }],
    }
    const outcome = await deliver(gone)

    expect(outcome.quarantined).toBe(1)
    expect(await has(b.db, 'categories', category), 'the product still has its category').toBe(true)
    const [held] = await quarantinedRecords(b.db)
    expect(held?.reason).toContain('products on this till still points at it')
  })
})
