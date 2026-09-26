import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { collectChanges, applyBatch, recentConflicts } from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct, type Fixture, editingSubmitted } from './helpers.js'
import type { Row, SqlDriver } from '../src/db/driver.js'

/**
 * A bill that has been rung up, and a peer that says otherwise.
 *
 * The merge compares a revision and a timestamp and knew nothing about
 * docstatus, so a peer could overwrite a submitted invoice and the later
 * timestamp would win. What that costs is not a lost edit: it is a printed
 * invoice, with stock moved against it, quietly taking a different total — and
 * GSTR-1 filed off that number.
 *
 * The route that made this urgent is closed from the other end too. A draft used
 * to replicate, so one counter could submit a bill while the other carried on
 * typing into its copy, and the one still being typed carried the later
 * timestamp. Migration 042 keeps drafts at home. What remains, and what this
 * guards, is every other way a peer can arrive holding a different version of a
 * document that is already final here: a till on an older build, a restored
 * backup, a row edited by hand. The rule belongs in the merge rather than in
 * the list of things that cannot happen.
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

async function push(from: Till, to: Till) {
  const batch = await as(from, () => collectChanges(from.db, 0, 500, to.id))
  return as(to, () => applyBatch(to.db, batch, new Set()))
}

const now = () => new Date().toISOString()

/**
 * A submitted bill on both tills.
 *
 * Submitted before it is pushed, and that is not a convenience: since 042 a
 * draft does not travel at all, so a bill that reaches the other till is a bill
 * that was rung up.
 */
async function billOnBoth(): Promise<string> {
  const product = await makeProduct(a.db, { id: newId(), name: 'Rice 1kg' })
  const billId = newId()
  const at = now()
  const user = await a.db.get<{ id: string }>(`SELECT id FROM users LIMIT 1`)

  await a.db.execute(
    `INSERT INTO bills
       (id, doc_no, register_id, posting_date, docstatus,
        subtotal, taxable_total, grand_total, paid_total,
        created_by, created_at, updated_at)
     VALUES (?, 'BFR/2627/00001', ?, ?, 0, 10000, 10000, 10000, 0, ?, ?, ?)`,
    [billId, a.fx!.seed.registerId, at.slice(0, 10), user!.id, at, at],
  )
  await a.db.execute(
    `INSERT INTO bill_items
       (id, bill_id, idx, product_id, product_name, sale_unit, qty, base_qty,
        rate, line_total, taxable_value, price_source)
     VALUES (?, ?, 1, ?, 'Rice 1kg', 'piece', 10000, 10000, 10000, 10000, 10000, 'base')`,
    [newId(), billId, product],
  )

  await a.db.execute(
    `UPDATE bills SET docstatus = 1, updated_at = ? WHERE id = ?`,
    ['2026-09-18T09:00:00.000Z', billId],
  )
  await push(a, b)
  return billId
}

async function grandTotalOn(till: Till, billId: string): Promise<number | undefined> {
  const row = await till.db.get<{ grand_total: number }>(
    `SELECT grand_total FROM bills WHERE id = ?`, [billId],
  )
  return row?.grand_total
}

describe('a bill the other till is still typing into', () => {
  it('cannot change what a submitted one came to', async () => {
    const billId = await billOnBoth()

    /* A's copy is changed after it was submitted — by whatever route, and the
       merge is not in a position to know which. It carries the later timestamp,
       so it wins every tiebreak there is. */
    await editingSubmitted(a.db, 'bills', () => a.db.execute(
      `UPDATE bills SET grand_total = 99900, subtotal = 99900, updated_at = ? WHERE id = ?`,
      ['2026-09-18T11:00:00.000Z', billId],
    ))

    await push(a, b)

    expect(
      await grandTotalOn(b, billId),
      'the invoice B printed still says what it said',
    ).toBe(10000)
  })

  it('says so, rather than dropping it quietly', async () => {
    const billId = await billOnBoth()
    await editingSubmitted(a.db, 'bills', () => a.db.execute(
      `UPDATE bills SET grand_total = 99900, updated_at = ? WHERE id = ?`,
      ['2026-09-18T11:00:00.000Z', billId],
    ))

    await push(a, b)

    const [logged] = await as(b, () => recentConflicts(b.db))
    expect(logged?.table).toBe('bills')
    expect(logged?.rowId).toBe(billId)
    expect(logged?.winner).toBe('mine')
    expect(logged?.explain, 'and names what they disagree about').toContain('grand_total')
  })

  it('will not turn a cancelled bill back into a live one', async () => {
    const billId = await billOnBoth()
    await b.db.execute(
      `UPDATE bills SET docstatus = 2, cancel_reason = 'wrong customer', updated_at = ? WHERE id = ?`,
      ['2026-09-18T10:00:00.000Z', billId],
    )
    // A, which has not heard, edits its still-submitted copy later.
    await a.db.execute(
      `UPDATE bills SET notes = 'still selling this', updated_at = ? WHERE id = ?`,
      ['2026-09-18T11:00:00.000Z', billId],
    )

    await push(a, b)

    const row = await b.db.get<Row>(`SELECT docstatus FROM bills WHERE id = ?`, [billId])
    expect(row?.['docstatus'], 'cancelled is the end of it').toBe(2)
  })

  /**
   * The other half, and the one an earlier draft of this rule got wrong: a
   * submitted document's *lines* do change. Refusing those would drop returns,
   * order fulfilment and payment allocation between tills.
   */
  it('still takes a return recorded against it on the other till', async () => {
    const billId = await billOnBoth()

    /* A takes one back: the return itself, and the line's count of what came
       back. The head row is untouched except for its timestamp. The return is
       recorded as well as the count because the count is a cache of returns --
       after a merge it is held to them, and a count with no return behind it
       is put back to zero. */
    const billLine = await a.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [billId])
    const user = await a.db.get<{ id: string }>(`SELECT id FROM users LIMIT 1`)
    const returnId = newId()
    const at = '2026-09-18T11:00:00.000Z'
    await a.db.execute(
      `INSERT INTO sales_returns
         (id, doc_no, docstatus, bill_id, posting_date, refund_total, refund_method, created_by, created_at, updated_at)
       VALUES (?, 'CFR/2627/00001', 1, ?, '2026-09-18', 10000, 'cash', ?, ?, ?)`,
      [returnId, billId, user!.id, at, at],
    )
    const product = await a.db.get<{ product_id: string }>(`SELECT product_id FROM bill_items WHERE id = ?`, [billLine!.id])
    await a.db.execute(
      `INSERT INTO sales_return_items (id, return_id, bill_item_id, product_id, qty, base_qty, refund_amount)
       VALUES (?, ?, ?, ?, 10000, 10000, 10000)`,
      [newId(), returnId, billLine!.id, product!.product_id],
    )
    await a.db.execute(`UPDATE bill_items SET returned_qty = 10000 WHERE bill_id = ?`, [billId])
    await a.db.execute(`UPDATE bills SET updated_at = ? WHERE id = ?`, [at, billId])

    await push(a, b)

    const line = await b.db.get<{ returned_qty: number }>(
      `SELECT returned_qty FROM bill_items WHERE bill_id = ?`, [billId],
    )
    expect(line?.returned_qty, 'the return crossed').toBe(10000)
    expect(await grandTotalOn(b, billId), 'and the invoice is untouched').toBe(10000)
  })

  it('overwrites one that is still a draft here, which is what a draft is', async () => {
    /* The guard reads the docstatus of the row *being overwritten*, not the one
       arriving. A bill still open at this counter is not a record of anything
       yet, and the shop's answer about it is whoever edited it last. */
    const billId = await billOnBoth()
    await editingSubmitted(b.db, 'bills', () => b.db.execute(`UPDATE bills SET docstatus = 0 WHERE id = ?`, [billId]))
    await editingSubmitted(a.db, 'bills', () => a.db.execute(
      `UPDATE bills SET grand_total = 25000, updated_at = ? WHERE id = ?`,
      ['2026-09-18T11:00:00.000Z', billId],
    ))

    await push(a, b)

    expect(await grandTotalOn(b, billId)).toBe(25000)
  })
})

describe('the lines of a submitted bill', () => {
  /* The header has been guarded since 059 and by `refusedAsSubmitted`; the
     lines were rewritten wholesale by any copy of the bill that won the merge.
     A cancellation from a till that held different lines would have left the
     invoice here with a total its lines no longer add up to. */

  async function cancelOnA(billId: string) {
    await editingSubmitted(a.db, 'bills', () => a.db.execute(
      `UPDATE bills SET docstatus = 2, updated_at = ? WHERE id = ?`,
      ['2026-09-18T12:00:00.000Z', billId],
    ))
  }

  const lineOn = (till: Till, billId: string) => till.db.get<{ rate: number; line_total: number; returned_qty: number }>(
    `SELECT rate, line_total, returned_qty FROM bill_items WHERE bill_id = ?`, [billId],
  )
  const statusOn = async (till: Till, billId: string) =>
    (await till.db.get<{ docstatus: number }>(`SELECT docstatus FROM bills WHERE id = ?`, [billId]))?.docstatus

  it('are not replaced by a copy that holds different ones', async () => {
    const billId = await billOnBoth()
    await a.db.execute(
      `UPDATE bill_items SET rate = 99900, line_total = 99900 WHERE bill_id = ?`, [billId],
    )
    await cancelOnA(billId)

    await push(a, b)

    expect(await lineOn(b, billId), 'the line B printed').toMatchObject({ rate: 10000, line_total: 10000 })
    expect(await statusOn(b, billId), 'and the copy carrying it was refused whole').toBe(1)
    const conflicts = await recentConflicts(b.db)
    expect(conflicts.some((c) => c.rowId === billId && c.explain.includes('bill_items'))).toBe(true)
  })

  it('let an honest cancellation through', async () => {
    const billId = await billOnBoth()
    await cancelOnA(billId)

    await push(a, b)

    expect(await statusOn(b, billId)).toBe(2)
    expect(await lineOn(b, billId)).toMatchObject({ rate: 10000, line_total: 10000 })
  })

  it('may differ in what has come back against them, which is a cache', async () => {
    const billId = await billOnBoth()
    await a.db.execute(`UPDATE bill_items SET returned_qty = 10000 WHERE bill_id = ?`, [billId])
    await cancelOnA(billId)

    await push(a, b)

    expect(await statusOn(b, billId), 'returned_qty is not part of the invoice').toBe(2)
  })
})
