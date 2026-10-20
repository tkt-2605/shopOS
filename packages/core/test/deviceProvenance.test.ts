import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setDeviceId, deviceId } from '../src/device.js'
import { writeAudit } from '../src/integrity/audit.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { createCustomer } from '../src/services/customers.js'
import { fromUnits } from '../src/quantity.js'
import { rupees } from '../src/money.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Two promises 001's header has been making since day one, one of which was
 * never kept and one of which was kept three times out of eight.
 *
 * `origin_id` has never been written by anything. `rev` was bumped by 16 of the
 * 64 UPDATE statements in the service layer — and a merge that picked a winner
 * by comparing rev would have silently discarded every change made through the
 * other 48, while appearing to work. Migration 019 answers the first with a
 * device on every audit row and the second with a trigger, because a convention
 * 48 call sites have to remember is not a convention.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

let fx: Fixture

beforeEach(async () => {
  fx = await freshDb()
  setDeviceId(A)
})

afterEach(async () => {
  setDeviceId(null)
  await fx.db.close()
})

describe('which machine a change came from', () => {
  it('is on every audit row, without a caller having to pass it', async () => {
    await createCustomer(fx.db, { actorId: fx.adminId }, { name: 'Lakshmi Stores', phone: '9847778899' })

    const rows = await fx.db.query<{ device_id: string | null }>(
      `SELECT device_id FROM audit_log WHERE entity = 'customers'`,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.device_id === A)).toBe(true)
  })

  it('tells two tills apart on the same database', async () => {
    const p = await makeProduct(fx.db, { name: 'Sugar 1kg', baseRate: rupees(48) })

    async function ring(): Promise<string> {
      const draft = await createBill(fx.db, {
        registerId: fx.seed.registerId,
        lines: [{ productId: p, qty: fromUnits(1) }],
        actorId: fx.adminId,
      })
      if (!draft.ok) throw new Error(draft.code)
      await submitBill(fx.db, {
        billId: draft.billId,
        payments: [{ method: 'cash', amount: draft.grandTotal }],
        actorId: fx.adminId,
      })
      return draft.billId
    }

    setDeviceId(A)
    const first = await ring()
    setDeviceId(B)
    const second = await ring()

    const deviceFor = async (billId: string) =>
      (await fx.db.get<{ device_id: string | null }>(
        `SELECT device_id FROM audit_log WHERE entity = 'bills' AND entity_id = ? ORDER BY at LIMIT 1`,
        [billId],
      ))?.device_id

    expect(await deviceFor(first)).toBe(A)
    expect(await deviceFor(second)).toBe(B)
  })

  it('is overridden when a caller is writing on another machine\'s behalf', async () => {
    // This is the shape sync will need: the till that made the change is named,
    // not the one applying it.
    await fx.db.transaction(async (tx) => {
      await writeAudit(tx, { actorId: fx.adminId, deviceId: B }, {
        entity: 'products', entityId: 'p1', action: 'update',
        before: { name: 'Old' }, after: { name: 'New' },
      })
    })

    const row = await fx.db.get<{ device_id: string | null }>(
      `SELECT device_id FROM audit_log WHERE entity_id = 'p1'`,
    )
    expect(row?.device_id).toBe(B)
  })

  it('records nothing rather than something wrong when the machine is unknown', async () => {
    // A till that cannot name itself still has to be able to sell. An
    // unattributed row is the old behaviour; an invented device id would be a
    // lie in a history that people rely on.
    setDeviceId(null)
    await createCustomer(fx.db, { actorId: fx.adminId }, { name: 'Walk-in', phone: '9000000001' })

    const row = await fx.db.get<{ device_id: string | null }>(
      `SELECT device_id FROM audit_log WHERE entity = 'customers' ORDER BY at DESC LIMIT 1`,
    )
    expect(row?.device_id).toBeNull()
    expect(deviceId()).toBeNull()
  })
})

describe('rev, on every replicated table', () => {
  /** The set the schema itself declares, read back rather than listed by hand. */
  async function replicatedTables(): Promise<string[]> {
    const tables = await fx.db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    const out: string[] = []
    for (const { name } of tables) {
      const cols = await fx.db.query<{ name: string }>(`PRAGMA table_info("${name}")`)
      const has = new Set(cols.map((c) => c.name))
      if (has.has('rev') && has.has('origin_id')) out.push(name)
    }
    return out
  }

  it('has a trigger on every table that carries it, with none left out', async () => {
    const tables = await replicatedTables()
    // 020 added `settings`; 022 added `doc_formats`, which 021 had to feed
    // without anything to settle a tie with; 049 added `user_sessions`; 062
    // added `batches`; 076 `bill_emails`.
    expect(tables.length).toBe(25)

    const triggers = new Set(
      (await fx.db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bump_rev_%'`,
      )).map((t) => t.name),
    )

    const missing = tables.filter((t) => !triggers.has(`bump_rev_${t}`))
    expect(missing).toEqual([])
  })

  /* The reason the trigger exists: this is the statement shape that has been
     losing revisions in fourteen of eighteen services. */
  it('rises on an update that never mentions it', async () => {
    const p = await makeProduct(fx.db, { name: 'Notebook' })
    const revOf = async () =>
      (await fx.db.get<{ rev: number }>(`SELECT rev FROM products WHERE id = ?`, [p]))!.rev

    expect(await revOf()).toBe(1)

    await fx.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Notebook A5', p])
    expect(await revOf()).toBe(2)

    await fx.db.execute(`UPDATE products SET brand = ? WHERE id = ?`, ['Classmate', p])
    expect(await revOf()).toBe(3)
  })

  it('counts a change once, not twice, when the statement bumps it too', async () => {
    // The sixteen statements that were already correct must not now double-count,
    // or every one of those rows would out-rank an honest change from another till.
    const p = await makeProduct(fx.db, { name: 'Pen' })

    await fx.db.execute(`UPDATE products SET name = ?, rev = rev + 1 WHERE id = ?`, ['Pen blue', p])

    const row = await fx.db.get<{ rev: number }>(`SELECT rev FROM products WHERE id = ?`, [p])
    expect(row?.rev).toBe(2)
  })

  it('rises on a soft delete, which is a change like any other', async () => {
    const p = await makeProduct(fx.db, { name: 'Discontinued' })
    await fx.db.execute(`UPDATE products SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), p])

    const row = await fx.db.get<{ rev: number }>(`SELECT rev FROM products WHERE id = ?`, [p])
    expect(row?.rev).toBe(2)
  })

  it('leaves rows alone that nothing updated', async () => {
    const a = await makeProduct(fx.db, { name: 'Untouched' })
    const b = await makeProduct(fx.db, { name: 'Touched' })

    await fx.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Touched twice', b])

    const rows = await fx.db.query<{ id: string; rev: number }>(
      `SELECT id, rev FROM products WHERE id IN (?, ?)`, [a, b],
    )
    expect(rows.find((r) => r.id === a)?.rev).toBe(1)
    expect(rows.find((r) => r.id === b)?.rev).toBe(2)
  })

  it('rises through the service layer, on a service that never bumped it by hand', async () => {
    // registers.ts had two replicated UPDATEs and not one `rev = rev + 1`.
    const before = await fx.db.get<{ rev: number }>(
      `SELECT rev FROM registers WHERE id = ?`, [fx.seed.registerId],
    )
    await fx.db.execute(
      `UPDATE registers SET name = ? WHERE id = ?`, ['Front counter', fx.seed.registerId],
    )
    const after = await fx.db.get<{ rev: number }>(
      `SELECT rev FROM registers WHERE id = ?`, [fx.seed.registerId],
    )
    expect(after!.rev).toBe(before!.rev + 1)
  })
})
