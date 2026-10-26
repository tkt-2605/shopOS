import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  changesSince, feedHead, pendingCount, applyingRemote, isApplyingRemote,
  resetSyncState, pruneFeed,
} from '../src/services/changefeed.js'
import { setSetting } from '../src/services/bootstrap.js'
import { createBill } from '../src/services/billing.js'
import { fromUnits } from '../src/quantity.js'
import { NOT_REPLICATED } from '../src/domain/replicaShape.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * The changefeed: what has changed here since a till last asked.
 *
 * Every test in this file is about one of the three ways a feed is worse than
 * useless rather than merely incomplete:
 *
 * * a change that never reaches it — the row silently never replicates, and
 *   nothing afterwards mentions it again;
 * * a change that reaches it when it should not — two tills pass one row back
 *   and forth for ever;
 * * an ordering that lets a cursor step over something.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function feed(cursor = 0) {
  return changesSince(fx.db, cursor)
}

async function entriesFor(table: string) {
  return (await feed()).filter((c) => c.table === table)
}

describe('what lands in the feed', () => {
  it('records a row the moment it is created', async () => {
    const id = await makeProduct(fx.db, { name: 'Notebook' })
    const mine = await entriesFor('products')

    expect(mine.map((c) => c.rowId)).toContain(id)
    expect(mine.find((c) => c.rowId === id)?.op).toBe('upsert')
  })

  it('records a change made by a statement that never mentions the feed', async () => {
    // The whole reason this is a trigger: no call site has to remember.
    const id = await makeProduct(fx.db, { name: 'Notebook' })
    await pruneFeed(fx.db, await feedHead(fx.db))

    await fx.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Ledger', id])

    expect((await entriesFor('products')).map((c) => c.rowId)).toEqual([id])
  })

  it('keeps one entry per row however many times it changes', async () => {
    const id = await makeProduct(fx.db, { name: 'Notebook' })
    for (const name of ['A', 'B', 'C', 'D']) {
      await fx.db.execute(`UPDATE products SET name = ? WHERE id = ?`, [name, id])
    }

    // A price edited forty times before anyone asks is one row to send, not forty.
    expect((await entriesFor('products')).filter((c) => c.rowId === id)).toHaveLength(1)
  })

  it('moves a row that changes again to the back of the queue', async () => {
    const first = await makeProduct(fx.db, { name: 'First' })
    const second = await makeProduct(fx.db, { name: 'Second' })

    const before = await feed()
    expect(before.findIndex((c) => c.rowId === first))
      .toBeLessThan(before.findIndex((c) => c.rowId === second))

    await fx.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Again', first])

    const after = await feed()
    expect(after.findIndex((c) => c.rowId === first))
      .toBeGreaterThan(after.findIndex((c) => c.rowId === second))
  })

  it('says a row is gone when it is genuinely removed', async () => {
    const id = await makeProduct(fx.db, { name: 'Notebook' })
    await fx.db.execute(`DELETE FROM product_barcodes WHERE product_id = ?`, [id])
    await fx.db.execute(`DELETE FROM product_units WHERE product_id = ?`, [id])
    await fx.db.execute(`DELETE FROM item_prices WHERE product_id = ?`, [id])
    await fx.db.execute(`DELETE FROM product_stock WHERE product_id = ?`, [id])
    await fx.db.execute(`DELETE FROM products WHERE id = ?`, [id])

    const mine = (await entriesFor('products')).find((c) => c.rowId === id)
    expect(mine?.op).toBe('delete')
  })

  it('treats a soft delete as a change, because the row is still there to send', async () => {
    const id = await makeCustomer(fx.db, 'Priya')
    await pruneFeed(fx.db, await feedHead(fx.db))

    await fx.db.execute(
      `UPDATE customers SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id],
    )

    const mine = (await entriesFor('customers')).find((c) => c.rowId === id)
    expect(mine?.op).toBe('upsert')
  })

  it('carries a setting, which is the shop rather than the machine', async () => {
    await setSetting(fx.db, 'shop_name', 'TRT Stationery')
    expect((await entriesFor('settings')).map((c) => c.rowId)).toContain('shop_name')
  })
})

describe('a document travels whole', () => {
  /* A bill is its lines. A line changing without the bill row changing is the
     case where a naive feed sends a bill that is missing what changed about it. */

  it('marks the bill when one of its lines changes', async () => {
    const productId = await makeProduct(fx.db, { name: 'Notebook' })
    const billId = await onlyBill(productId)
    await pruneFeed(fx.db, await feedHead(fx.db))

    await fx.db.execute(`UPDATE bill_items SET qty = qty + 1 WHERE bill_id = ?`, [billId])

    expect((await entriesFor('bills')).map((c) => c.rowId)).toEqual([billId])
    // And the line itself is not offered as a thing of its own.
    expect(await entriesFor('bill_items')).toEqual([])
  })

  it('marks the bill when a line is removed, without calling the bill deleted', async () => {
    const productId = await makeProduct(fx.db, { name: 'Notebook' })
    const billId = await onlyBill(productId)
    await pruneFeed(fx.db, await feedHead(fx.db))

    await fx.db.execute(`DELETE FROM bill_items WHERE bill_id = ?`, [billId])

    const mine = (await entriesFor('bills')).find((c) => c.rowId === billId)
    expect(mine?.op).toBe('upsert')
  })

  it('moves the document’s revision, not only its place in the queue', async () => {
    /* Marking the parent dirty sends the bill; moving its rev is what makes the
       far side accept it. Without both, a merge comparing rev keeps its own copy
       and the change is dropped while everything appears to work. */
    const productId = await makeProduct(fx.db, { name: 'Notebook' })
    const billId = await onlyBill(productId)
    const before = await revOf('bills', billId)

    await fx.db.execute(`UPDATE bill_items SET returned_qty = returned_qty WHERE bill_id = ?`, [billId])

    expect(await revOf('bills', billId)).toBeGreaterThan(before)
  })

  it('moves a role’s revision when a page is granted to it', async () => {
    /* The case that made this a trigger. `saveRoleMatrix` updates the role
       itself, so it was fine; `applyUpgrades` writes the same two tables and has
       no reason to touch the role — so a newly granted screen reached the second
       till as a role whose revision said nothing had changed. */
    const roleId = fx.seed.roleIds['Admin']!
    const before = await revOf('roles', roleId)

    await fx.db.execute(
      `INSERT INTO role_pages (role_id, page_key, visible) VALUES (?, 'formats', 1)
       ON CONFLICT (role_id, page_key) DO UPDATE SET visible = excluded.visible`,
      [roleId],
    )

    expect(await revOf('roles', roleId)).toBeGreaterThan(before)
    expect((await entriesFor('roles')).map((c) => c.rowId)).toContain(roleId)
  })

  async function revOf(table: string, id: string): Promise<number> {
    const row = await fx.db.get<{ rev: number }>(
      `SELECT rev FROM ${table} WHERE id = ?`, [id],
    )
    return row?.rev ?? 0
  }

  /** A real bill through the real service, so the columns stay the service's
      business rather than this file's. */
  async function onlyBill(productId: string): Promise<string> {
    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(`could not raise a bill: ${made.code}`)

    /* Rung up, not half-typed. `createBill` leaves a draft, and since migration
       042 a draft is deliberately none of the other tills' business — so a
       draft would prove nothing here except that the guard works. Written
       directly rather than through `submitBill` because this file is about the
       triggers, and a bill that failed on stock policy would fail as the wrong
       thing. */
    await fx.db.execute(
      `UPDATE bills SET docstatus = 1, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), made.billId],
    )
    return made.billId
  }
})

describe('changes that came from somewhere else', () => {
  it('does not feed back what a merge wrote', async () => {
    const id = await makeProduct(fx.db, { name: 'Notebook' })
    await pruneFeed(fx.db, await feedHead(fx.db))

    /* Without this the other till pulls its own change back, applies it, feeds
       it again, and the two of them hand one row to and fro for ever. */
    await applyingRemote(fx.db, async (tx) => {
      await tx.execute(`UPDATE products SET name = ? WHERE id = ?`, ['From the other till', id])
    })

    expect(await feed()).toEqual([])
  })

  it('goes back to recording as soon as the merge is over', async () => {
    const id = await makeProduct(fx.db, { name: 'Notebook' })
    await applyingRemote(fx.db, async (tx) => {
      await tx.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Theirs', id])
    })
    await pruneFeed(fx.db, await feedHead(fx.db))

    await fx.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Ours', id])

    expect((await feed()).map((c) => c.rowId)).toContain(id)
    expect(await isApplyingRemote(fx.db)).toBe(false)
  })

  it('never leaves the feed switched off when a merge fails', async () => {
    // A till that silently stops telling anyone anything is the worst outcome
    // this file has, and it must not be reachable by a merge that throws.
    const id = await makeProduct(fx.db, { name: 'Notebook' })

    await expect(applyingRemote(fx.db, async (tx) => {
      await tx.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Half done', id])
      throw new Error('the other till went away')
    })).rejects.toThrow('the other till went away')

    expect(await isApplyingRemote(fx.db)).toBe(false)

    await fx.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['After', id])
    expect((await feed()).map((c) => c.rowId)).toContain(id)
  })

  it('rolls the half-done merge back with it', async () => {
    const id = await makeProduct(fx.db, { name: 'Notebook' })

    await expect(applyingRemote(fx.db, async (tx) => {
      await tx.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Half done', id])
      throw new Error('no')
    })).rejects.toThrow()

    const row = await fx.db.get<{ name: string }>(
      `SELECT name FROM products WHERE id = ?`, [id],
    )
    expect(row?.name).toBe('Notebook')
  })

  it('is a no-op at startup, and says so by changing nothing', async () => {
    await resetSyncState(fx.db)
    expect(await isApplyingRemote(fx.db)).toBe(false)
  })
})

describe('the cursor', () => {
  it('hands back only what is newer', async () => {
    await makeProduct(fx.db, { name: 'First' })
    const mark = await feedHead(fx.db)
    const second = await makeProduct(fx.db, { name: 'Second' })

    const after = await feed(mark)
    expect(after.map((c) => c.rowId)).toContain(second)
    expect(after.every((c) => c.seq > mark)).toBe(true)
  })

  it('never reuses a seq, so a cursor cannot step over a row', async () => {
    const id = await makeProduct(fx.db, { name: 'Notebook' })
    const first = (await feed()).find((c) => c.rowId === id)!.seq

    await pruneFeed(fx.db, await feedHead(fx.db))
    const other = await makeProduct(fx.db, { name: 'Second' })

    const reused = (await feed()).find((c) => c.rowId === other)!.seq
    expect(reused).toBeGreaterThan(first)
  })

  it('counts what is still waiting', async () => {
    expect(await pendingCount(fx.db)).toBe((await feed()).length)
    const mark = await feedHead(fx.db)
    await makeProduct(fx.db, { name: 'Another' })
    expect(await pendingCount(fx.db, mark)).toBe(1)
  })

  it('forgets only what it is told to forget', async () => {
    await makeProduct(fx.db, { name: 'First' })
    const mark = await feedHead(fx.db)
    await makeProduct(fx.db, { name: 'Second' })

    const dropped = await pruneFeed(fx.db, mark)

    expect(dropped).toBeGreaterThan(0)
    expect((await feed()).every((c) => c.seq > mark)).toBe(true)
  })
})

describe('the set of tables it covers', () => {
  /* Derived from the schema rather than listed here, so a table added next year
     cannot be quietly left out — the failure that would cause is a row that
     never replicates and never says it did not. */

  /* The excluded set is not typed out again here. It lives in `replicaShape.ts`
     with a reason beside each name, and a second copy of it would be one more
     place to add a table to and forget. */

  it('feeds every table that carries a revision', async () => {
    const tables = await fx.db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )

    const revTables: string[] = []
    for (const { name } of tables) {
      const cols = await fx.db.query<{ name: string }>(`PRAGMA table_info("${name}")`)
      if (cols.some((c) => c.name === 'rev')) revTables.push(name)
    }
    // 022 gave doc_formats one, so it has a tiebreaker of its own rather than
    // being merged on the two machines' clocks; 049 added user_sessions, and
    // 051 loyalty_entries, which is edited and so needs one to merge by; 062
    // batches, whose expiry is filled in after the fact; 076 bill_emails, a
    // note written again when a failed bill fails again; 080 web_accounts,
    // web_orders and product_photos, the storefront's.
    expect(revTables.length).toBe(29)

    const triggers = new Set(
      (await fx.db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'feed_%'`,
      )).map((t) => t.name),
    )

    const missing = revTables.flatMap((t) =>
      ['ins', 'upd', 'del'].map((op) => `feed_${t}_${op}`).filter((n) => !triggers.has(n)))
    expect(missing).toEqual([])
  })

  it('has a decision recorded for every table in the schema', async () => {
    const tables = (await fx.db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )).map((t) => t.name)

    const triggers = (await fx.db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'feed_%'`,
    )).map((t) => t.name)
    const fed = new Set(triggers.map((n) => n.replace(/^feed_/, '').replace(/_(ins|upd|del)$/, '')))

    // Every table is either fed, or excluded on purpose with its reason recorded.
    const unaccounted = tables.filter((t) => !fed.has(t) && NOT_REPLICATED[t] === undefined)
    expect(unaccounted).toEqual([])
  })
})
