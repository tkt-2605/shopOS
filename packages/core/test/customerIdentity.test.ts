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
import { bootstrap } from '../src/services/bootstrap.js'
import { setDeviceId } from '../src/device.js'
import type { SqlDriver } from '../src/db/driver.js'

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

/**
 * The shop's reference number, once there is more than one counter.
 *
 * `MAX + 1` computed on two machines that cannot see each other returns the
 * same number twice, and `customers.code` carries no unique index, so the merge
 * applies both and nothing anywhere says that C0005 now names two people. The
 * prefix is what `doc_no` has always used against exactly this, and it is what
 * the series uses now.
 */
describe('two counters minting at once', () => {
  async function till(prefix: string, device: string): Promise<SqlDriver> {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS)
    const seed = await bootstrap(db, { shopName: 'Test Shop', registerPrefix: prefix })
    await db.execute(`UPDATE registers SET claimed_by = ? WHERE id = ?`, [device, seed.registerId])
    return db
  }

  /** A customer the shop already had before the tills lost sight of each other. */
  async function alreadyHas(db: SqlDriver, code: string): Promise<void> {
    const now = new Date().toISOString()
    await db.execute(
      `INSERT INTO customers (id, code, name, state_code, created_at, updated_at)
       VALUES (?, ?, 'Before the split', '33', ?, ?)`,
      [newId(), code, now, now],
    )
  }

  afterEach(() => { setDeviceId(null) })

  it('does not give two people the same reference', async () => {
    const front = await till('MR', 'device-front')
    const back = await till('B2', 'device-back')
    for (const db of [front, back]) await alreadyHas(db, 'C0004')

    setDeviceId('device-front')
    const atTheFront = await nextCustomerCode(front)
    setDeviceId('device-back')
    const atTheBack = await nextCustomerCode(back)

    expect(atTheFront).not.toBe(atTheBack)
    expect([atTheFront, atTheBack]).toEqual(['CMR0005', 'CB20005'])

    await front.close()
    await back.close()
  })

  it('carries on from the number the shop had reached, not from one', async () => {
    /* A year on one till, then a second one arrives. Restarting at CMR0001 is
       unique and reads like the customer list has been wiped. */
    const db = await till('MR', 'device-front')
    setDeviceId('device-front')
    await alreadyHas(db, 'C0400')

    expect(await nextCustomerCode(db)).toBe('CMR0401')
    await db.close()
  })

  it('counts on in its own series once it has started one', async () => {
    const db = await till('MR', 'device-front')
    setDeviceId('device-front')
    await alreadyHas(db, 'C0400')

    const first = await createCustomer(db, { actorId: newId() }, { name: 'One' })
    const second = await createCustomer(db, { actorId: newId() }, { name: 'Two' })
    expect(first.ok && first.code).toBe('CMR0401')
    expect(second.ok && second.code).toBe('CMR0402')
    await db.close()
  })

  it('leaves a till that has claimed no counter minting as it always did', async () => {
    /* One till, never asked which counter it is. There is nobody to collide
       with, and its codes are printed in the shop's book. */
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS)
    await bootstrap(db, { shopName: 'Test Shop' })
    setDeviceId('device-alone')

    expect(await nextCustomerCode(db)).toBe('C0001')
    await db.close()
  })

  it('mints into whatever series it is told to', async () => {
    const db = await till('MR', 'device-front')
    setDeviceId('device-front')
    await alreadyHas(db, 'C0004')

    expect(await nextCustomerCode(db, 'B2')).toBe('CB20005')
    expect(await nextCustomerCode(db, null)).toBe('C0005')
    await db.close()
  })
})
