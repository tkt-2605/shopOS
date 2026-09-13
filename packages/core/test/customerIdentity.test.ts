import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import {
  createCustomer, updateCustomer, customerByPhone, nextCustomerCode, backfillCustomerCodes,
} from '../src/services/customers.js'
import { setFeature, isOn } from '../src/services/features.js'
import { searchCustomers } from '../src/repos/catalog.js'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { newId } from '../src/ids.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Telling one customer from another.
 *
 * The screen wrote to the database itself, so the same person could be entered
 * three times on one phone number and there was no layer that could say no.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

describe('the shop’s own reference', () => {
  it('is given out without anybody having to invent one', async () => {
    const a = await createCustomer(fx.db, ctx(), { name: 'Anand Stores' })
    const b = await createCustomer(fx.db, ctx(), { name: 'Bala Traders' })
    expect(a.ok && a.code).toBe('C0001')
    expect(b.ok && b.code).toBe('C0002')
  })

  it('takes the one the shop already writes in its book', async () => {
    const r = await createCustomer(fx.db, ctx(), { name: 'Anand Stores', code: 'ANAND' })
    expect(r.ok && r.code).toBe('ANAND')
  })

  /* Counted from the highest number rather than from how many customers there
     are, so removing one does not hand its reference to the next person. */
  it('does not reuse a number that has been given out', async () => {
    await createCustomer(fx.db, ctx(), { name: 'One' })
    await createCustomer(fx.db, ctx(), { name: 'Two' })
    await fx.db.execute(`UPDATE customers SET deleted_at = '2026-01-01' WHERE code = 'C0002'`)
    expect(await nextCustomerCode(fx.db)).toBe('C0003')
  })

  it('steps over one the shop typed by hand', async () => {
    await createCustomer(fx.db, ctx(), { name: 'Hand typed', code: 'C0001' })
    const next = await createCustomer(fx.db, ctx(), { name: 'Automatic' })
    expect(next.ok && next.code).toBe('C0002')
  })

  it('refuses to let two customers share one', async () => {
    await createCustomer(fx.db, ctx(), { name: 'Anand Stores', code: 'ANAND' })
    const clash = await createCustomer(fx.db, ctx(), { name: 'Another', code: 'ANAND' })
    expect(clash.ok).toBe(false)
    if (!clash.ok && clash.code === 'CODE_TAKEN') expect(clash.existing.name).toBe('Anand Stores')
  })

  it('finds a customer by it', async () => {
    await createCustomer(fx.db, ctx(), { name: 'Anand Stores', code: 'ANAND' })
    const found = await searchCustomers(fx.db, 'ANAND')
    expect(found[0]?.name).toBe('Anand Stores')
    expect(found[0]?.code).toBe('ANAND')
  })
})

describe('two customers on one phone number', () => {
  it('is refused, and says who already has it', async () => {
    await createCustomer(fx.db, ctx(), { name: 'Anand Stores', phone: '9840012345' })
    const again = await createCustomer(fx.db, ctx(), { name: 'Anand', phone: '9840012345' })

    expect(again.ok).toBe(false)
    if (!again.ok && again.code === 'PHONE_TAKEN') {
      expect(again.existing.name).toBe('Anand Stores')
      expect(again.existing.code).toBe('C0001')
    }
  })

  /* A household with one phone and two khata accounts is a real arrangement,
     and the shop is the only one that can say which case this is. */
  it('is allowed once the shop has turned the rule off', async () => {
    await setFeature(fx.db, ctx(), 'uniquePhone', false)
    await createCustomer(fx.db, ctx(), { name: 'Anand Stores', phone: '9840012345' })
    const again = await createCustomer(fx.db, ctx(), { name: 'Anand’s wife', phone: '9840012345' })
    expect(again.ok).toBe(true)
  })

  it('does not stop a customer keeping their own number when edited', async () => {
    const made = await createCustomer(fx.db, ctx(), { name: 'Anand Stores', phone: '9840012345' })
    if (!made.ok) throw new Error(made.code)

    const saved = await updateCustomer(fx.db, ctx(), made.customerId, {
      name: 'Anand Stores & Sons', phone: '9840012345', creditLimit: rupees(5000),
    })
    expect(saved.ok).toBe(true)
  })

  it('is answered before the save, so the screen can offer to open them', async () => {
    await createCustomer(fx.db, ctx(), { name: 'Anand Stores', phone: '9840012345' })
    const who = await customerByPhone(fx.db, '9840012345')
    expect(who?.name).toBe('Anand Stores')
    expect(await customerByPhone(fx.db, '9999999999')).toBeNull()
  })

  it('ignores a customer who has been removed', async () => {
    const made = await createCustomer(fx.db, ctx(), { name: 'Gone', phone: '9840012345' })
    if (!made.ok) throw new Error(made.code)
    await fx.db.execute(`UPDATE customers SET deleted_at = '2026-01-01' WHERE id = ?`, [made.customerId])

    const again = await createCustomer(fx.db, ctx(), { name: 'New', phone: '9840012345' })
    expect(again.ok).toBe(true)
  })
})

describe('a shop that was already doing it', () => {
  /* The switch must never turn itself on and start refusing something the shop
     decided on purpose. Same rule as every other switch here. */
  it('keeps its shared numbers, and is not switched into refusing them', async () => {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version < 13))

    const now = new Date().toISOString()
    for (const name of ['Husband', 'Wife']) {
      await db.execute(
        `INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES (?, ?, '9840012345', ?, ?)`,
        [newId(), name, now, now],
      )
    }

    await migrate(db, MIGRATIONS)
    expect(await isOn(db, 'uniquePhone')).toBe(false)
    await db.close()
  })

  it('is protected from day one when its numbers are already distinct', async () => {
    expect(await isOn(fx.db, 'uniquePhone')).toBe(true)
  })

  it('gives a code to customers entered before codes existed', async () => {
    const now = new Date().toISOString()
    for (const name of ['Old One', 'Old Two']) {
      await fx.db.execute(
        `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        [newId(), name, now, now],
      )
    }

    expect(await backfillCustomerCodes(fx.db)).toBe(2)
    const codes = (await searchCustomers(fx.db, '')).map((c) => c.code)
    expect(codes).toEqual(['C0001', 'C0002'])
    // Safe to run on every start, which is where it runs.
    expect(await backfillCustomerCodes(fx.db)).toBe(0)
  })
})

describe('changing a customer', () => {
  it('is written down, which it never used to be', async () => {
    const made = await createCustomer(fx.db, ctx(), { name: 'Anand Stores' })
    if (!made.ok) throw new Error(made.code)
    await updateCustomer(fx.db, ctx(), made.customerId, {
      name: 'Anand Stores', creditLimit: rupees(5000),
    })

    const rows = await fx.db.query<{ action: string; diff: string }>(
      `SELECT action, diff FROM audit_log WHERE entity = 'customers' AND entity_id = ? ORDER BY rowid`,
      [made.customerId],
    )
    expect(rows.map((r) => r.action)).toEqual(['create', 'update'])
    expect(rows[1]?.diff).toContain('credit_limit')
  })

  it('needs a name', async () => {
    const r = await createCustomer(fx.db, ctx(), { name: '   ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NAME_REQUIRED')
  })
})
