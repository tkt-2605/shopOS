import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTauriDriver } from '../src/db/tauri-driver.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { q, schema } from '../src/db/q.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, type Qty } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver, SqlValue } from '../src/db/driver.js'

/**
 * The typed-query handle, before any service is moved onto it.
 *
 * Three things have to hold before a money path can be rewritten, and none of
 * them is that SQL becomes nicer to write:
 *
 * 1. **The values come back branded.** A `grand_total` read through `q()` is a
 *    `Money`, not a number, so it cannot be added to a `Qty` or to basis points
 *    by accident. Hand-written SQL gives back `number`, and every repo has had
 *    to re-apply the brand on the way out — a column somebody forgot to wrap
 *    was a plain number the compiler was happy with.
 * 2. **The columns land in the fields they were asked for**, which is what
 *    `queryValues` is for; `positionalRows.test.ts` covers the hazard itself.
 * 3. **A query inside a transaction goes out through the token.** Drizzle must
 *    never own the transaction: ShopOS's own `transaction()` does, and Rust is
 *    watching that one.
 */

let fx: Fixture
let db: SqlDriver

beforeEach(async () => {
  fx = await freshDb()
  db = fx.db
})
afterEach(async () => { await db.close() })

describe('a typed read', () => {
  it('returns the columns it asked for, in the fields it named them', async () => {
    const rows = await q(db)
      .select({ value: schema.settings.value, key: schema.settings.key })
      .from(schema.settings)
      .where(eq(schema.settings.key, 'shop_gstin'))

    expect(rows).toEqual([{ value: '33ALNPJ1906G1ZC', key: 'shop_gstin' }])
  })

  it('gives a whole row back as the table declares it', async () => {
    const [row] = await q(db).select().from(schema.settings)
      .where(eq(schema.settings.key, 'shop_gstin'))

    expect(row?.key).toBe('shop_gstin')
    expect(row?.rev).toBe(1)
  })

  it('finds nothing without inventing a row of nulls', async () => {
    const rows = await q(db).select().from(schema.settings)
      .where(eq(schema.settings.key, 'no_such_setting'))

    expect(rows).toEqual([])
  })

  it('counts', async () => {
    await makeProduct(db, { name: 'Rice 1kg' })
    await makeProduct(db, { name: 'Dal 1kg' })

    const [row] = await q(db).select({ n: sql<number>`count(*)` }).from(schema.products)

    expect(row?.n).toBe(2)
  })
})

describe('the brands', () => {
  it('come back on the money columns', async () => {
    const productId = await makeProduct(db, { baseRate: rupees(60) })

    const [row] = await q(db)
      .select({ rate: schema.products.baseRate })
      .from(schema.products)
      .where(eq(schema.products.id, productId))

    /* The assertion here is the compiler's, not the runtime's: `rate` is a
       `Money`, so this line typechecks and assigning it to a `Qty` would not.
       The value is the same integer paise it has always been. */
    const rate: Money | undefined = row?.rate
    expect(rate).toBe(rupees(60))
  })

  it('come back on the quantity columns', async () => {
    const productId = await makeProduct(db)
    await db.execute(`UPDATE products SET reorder_level = ? WHERE id = ?`, [fromUnits(5), productId])

    const [row] = await q(db)
      .select({ level: schema.products.reorderLevel })
      .from(schema.products)
      .where(eq(schema.products.id, productId))

    const level: Qty | null | undefined = row?.level
    expect(level).toBe(fromUnits(5))
  })
})

describe('a typed write', () => {
  it('inserts through the same driver', async () => {
    await q(db).insert(schema.settings).values({
      key: 'till_name', value: 'Counter 2', updatedAt: '2026-09-17T10:00:00+05:30',
    })

    const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'till_name'`)
    expect(row?.value).toBe('Counter 2')
  })

  it('updates', async () => {
    await q(db).update(schema.settings)
      .set({ value: 'Kumar General Stores' })
      .where(eq(schema.settings.key, 'shop_name'))

    const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'shop_name'`)
    expect(row?.value).toBe('Kumar General Stores')
  })
})

describe('inside a transaction', () => {
  it('reads what the transaction has written and not committed', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO settings (key, value, updated_at) VALUES ('till_name', 'Counter 2', 'now')`,
      )
      const rows = await q(tx).select({ value: schema.settings.value })
        .from(schema.settings).where(eq(schema.settings.key, 'till_name'))

      expect(rows).toEqual([{ value: 'Counter 2' }])
    })
  })

  it('is rolled back with everything else when the body throws', async () => {
    await expect(db.transaction(async (tx) => {
      await q(tx).insert(schema.settings).values({
        key: 'till_name', value: 'Counter 2', updatedAt: 'now',
      })
      throw new Error('no')
    })).rejects.toThrow('no')

    expect(await db.get(`SELECT value FROM settings WHERE key = 'till_name'`)).toBeUndefined()
  })

  it('gets a handle of its own, so one is not shared between transactions', async () => {
    const outside = q(db)
    const inside = await db.transaction(async (tx) => q(tx))

    /* On the node driver a nested transaction is the same object, so this is
       the weaker of the two proofs; the Tauri driver makes a `TxDriver` per
       transaction and the WeakMap then keys on it. What matters either way is
       that the handle is never cached across a boundary it should not cross. */
    expect(q(db)).toBe(outside)
    expect(inside).toBeTruthy()
  })
})

/** The fake Rust layer, recording which command each statement went out on. */
function recording(backing: SqlDriver) {
  const calls: string[] = []
  let token: string | null = null

  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push(cmd)
    const text = args['sql'] as string
    const params = (args['params'] ?? []) as SqlValue[]
    switch (cmd) {
      case 'sql_query': return backing.query(text, params)
      case 'sql_query_values': return backing.queryValues(text, params)
      case 'sql_execute':
        if (token !== null) throw 'a transaction is open'
        return backing.execute(text, params)
      case 'sql_tx_begin':
        await backing.execute('BEGIN IMMEDIATE')
        token = newId()
        return token
      case 'sql_tx_query': return backing.query(text, params)
      case 'sql_tx_query_values': return backing.queryValues(text, params)
      case 'sql_tx_execute': return backing.execute(text, params)
      case 'sql_tx_end':
        await backing.execute(args['commit'] === true ? 'COMMIT' : 'ROLLBACK')
        token = null
        return null
      default: throw `unknown command: ${cmd}`
    }
  }

  return { invoke, calls }
}

describe('on the till, where the database is in Rust', () => {
  it('sends a typed read inside a transaction through sql_tx_query_values', async () => {
    /* The check Phase 2's spec asks for by name. A read that went out through
       `sql_query_values` while a transaction was open would be reading around
       the transaction it believes it is in — and on one connection it would in
       fact join it, which is the right answer by accident. */
    const rust = recording(db)
    const tauri = createTauriDriver(rust.invoke)

    await tauri.transaction(async (tx) => {
      await q(tx).select({ value: schema.settings.value }).from(schema.settings)
    })

    expect(rust.calls).toEqual(['sql_tx_begin', 'sql_tx_query_values', 'sql_tx_end'])
  })

  it('sends a typed read outside one through sql_query_values', async () => {
    const rust = recording(db)
    const tauri = createTauriDriver(rust.invoke)

    await q(tauri).select({ value: schema.settings.value }).from(schema.settings)

    expect(rust.calls).toEqual(['sql_query_values'])
  })

  it('sends a typed write through the token, not around it', async () => {
    /* `sql_execute` is refused while a transaction is open, so a write that
       escaped the token would not merely be misfiled — it would fail. */
    const rust = recording(db)
    const tauri = createTauriDriver(rust.invoke)

    await tauri.transaction(async (tx) => {
      await q(tx).insert(schema.settings).values({
        key: 'till_name', value: 'Counter 2', updatedAt: 'now',
      })
    })

    expect(rust.calls).toEqual(['sql_tx_begin', 'sql_tx_execute', 'sql_tx_end'])
  })

  it('gives each transaction its own handle', async () => {
    const rust = recording(db)
    const tauri = createTauriDriver(rust.invoke)

    const first = await tauri.transaction(async (tx) => q(tx))
    const second = await tauri.transaction(async (tx) => q(tx))

    expect(first).not.toBe(second)
    expect(q(tauri)).not.toBe(first)
  })
})

describe('the money path, read both ways', () => {
  it('agrees with the SQL the services write by hand', async () => {
    /* Before a single service moves, the two ways of asking have to give the
       same answer about a real submitted bill — same rows, same paise. */
    const productId = await makeProduct(db, { baseRate: rupees(590), taxRateBp: 1800 })
    const draft = await createBill(db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(2) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft refused')
    const done = await submitBill(db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })
    if (!done.ok) throw new Error(`submit refused: ${done.code}`)

    const byHand = await db.query<{ doc_no: string; grand_total: number; docstatus: number }>(
      `SELECT doc_no, grand_total, docstatus FROM bills WHERE docstatus = 1 ORDER BY doc_no`,
    )
    const typed = await q(db)
      .select({
        docNo: schema.bills.docNo,
        grandTotal: schema.bills.grandTotal,
        docstatus: schema.bills.docstatus,
      })
      .from(schema.bills)
      .where(eq(schema.bills.docstatus, 1))
      .orderBy(schema.bills.docNo)

    expect(typed).toHaveLength(1)
    expect(typed).toEqual(
      byHand.map((r) => ({ docNo: r.doc_no, grandTotal: r.grand_total, docstatus: r.docstatus })),
    )
    expect(typed[0]?.grandTotal).toBe(rupees(1180))
  })
})
