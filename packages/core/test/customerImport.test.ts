import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  planCustomerImport, applyCustomerImport, exportCustomers, CUSTOMER_COLUMNS,
} from '../src/services/customerImport.js'
import { recordOpeningBalance } from '../src/services/payments.js'
import { rupees, type Money } from '../src/money.js'
import { freshDb, makeCustomer, type Fixture } from './helpers.js'

/**
 * The customer book, arriving as a spreadsheet.
 *
 * The matching order is the whole of this file's risk. Code, then phone, then
 * exact name — and name only when the row offers nothing stronger, because
 * two people called Kumar is the ordinary case and merging them joins two
 * accounts that owe different amounts.
 */

/* The shop's own administrator, read when used: an actor is checked against
   the roles now, so a made-up name would be refused. */
const ctx = { get actorId(): string { return fx.adminId } }

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('planning', () => {
  it('writes nothing', async () => {
    await planCustomerImport(fx.db, 'name,phone\r\nAnand,9876543210\r\n')
    expect(await fx.db.query('SELECT id FROM customers')).toHaveLength(0)
  })

  it('counts what it would add and change', async () => {
    await makeCustomer(fx.db, 'Anand')
    const plan = await planCustomerImport(fx.db, 'name\r\nAnand\r\nBala\r\n')
    expect(plan).toMatchObject({ create: 1, update: 1, skip: 0 })
  })

  it('matches on code before phone', async () => {
    const id = await makeCustomer(fx.db, 'Old name')
    await fx.db.execute('UPDATE customers SET code = ?, phone = ? WHERE id = ?',
      ['C001', '9876543210', id])

    const plan = await planCustomerImport(fx.db, 'name,code\r\nNew name,C001\r\n')
    expect(plan.rows[0]).toMatchObject({ action: 'update', customerId: id })
  })

  it('does not merge two people who share a name', async () => {
    /* Two Kumars with different numbers are two customers. Matching them
       together joins two accounts that owe different amounts, and nobody
       finds out until one is chased for the other's money. */
    const plan = await planCustomerImport(fx.db,
      'name,phone\r\nKumar,9000000001\r\nKumar,9000000002\r\n')
    expect(plan.rows.map((r) => r.problem)).toEqual([null, null])
    expect(plan.create).toBe(2)
  })

  it('refuses the same name twice when neither row says anything else', async () => {
    const plan = await planCustomerImport(fx.db, 'name\r\nKumar\r\nKumar\r\n')
    expect(plan.rows.map((r) => r.problem)).toEqual([null, 'NAME_TWICE'])
  })

  it('refuses a code and a phone that point at two different people', async () => {
    const one = await makeCustomer(fx.db, 'One')
    const two = await makeCustomer(fx.db, 'Two')
    await fx.db.execute('UPDATE customers SET code = ? WHERE id = ?', ['C001', one])
    await fx.db.execute('UPDATE customers SET phone = ? WHERE id = ?', ['9876543210', two])

    const plan = await planCustomerImport(fx.db, 'name,code,phone\r\nX,C001,9876543210\r\n')
    expect(plan.rows[0]?.problem).toBe('CODE_TAKEN')
  })

  it('checks a GSTIN and a state code rather than storing rubbish', async () => {
    const plan = await planCustomerImport(fx.db,
      'name,gstin\r\nGood,27AAPFU0939F1ZV\r\nBad,NOTAGSTIN\r\n')
    expect(plan.rows.map((r) => r.problem)).toEqual([null, 'BAD_GSTIN'])

    const states = await planCustomerImport(fx.db, 'name,state\r\nA,27\r\nB,99\r\n')
    expect(states.rows.map((r) => r.problem)).toEqual([null, 'BAD_STATE'])
  })

  it('takes a negative opening balance, which a price column would refuse', async () => {
    const plan = await planCustomerImport(fx.db, 'name,opening\r\nA,5000\r\nB,-1200\r\n')
    expect(plan.rows.map((r) => r.opening)).toEqual([rupees(5000), -rupees(1200)])
    expect(plan.withOpening).toBe(2)
  })

  it('names the line Excel shows, past a blank row', async () => {
    const plan = await planCustomerImport(fx.db, 'name,state\r\nA,27\r\n\r\nB,99\r\n')
    expect(plan.rows.find((r) => r.problem === 'BAD_STATE')?.line).toBe(4)
  })

  it('says which columns it ignored', async () => {
    const plan = await planCustomerImport(fx.db, 'name,loyalty tier\r\nA,gold\r\n')
    expect(plan.unknownColumns).toEqual(['loyaltytier'])
    expect(plan.create).toBe(1)
  })
})

describe('applying', () => {
  it('creates, and derives the state from the GSTIN', async () => {
    const plan = await planCustomerImport(fx.db, 'name,gstin\r\nAnand,27AAPFU0939F1ZV\r\n')
    const result = await applyCustomerImport(fx.db, ctx, plan)
    expect(result).toMatchObject({ created: 1, updated: 0 })

    const row = await fx.db.get<{ state_code: string }>('SELECT state_code FROM customers')
    // Never the literal 33 this INSERT used to carry for everybody.
    expect(row?.state_code).toBe('27')
  })

  it('leaves a blank cell alone rather than clearing it', async () => {
    const id = await makeCustomer(fx.db, 'Anand')
    await fx.db.execute('UPDATE customers SET address = ?, phone = ? WHERE id = ?',
      ['12 Main St', '9876543210', id])

    const plan = await planCustomerImport(fx.db, 'name,email\r\nAnand,a@example.com\r\n')
    await applyCustomerImport(fx.db, ctx, plan)

    const row = await fx.db.get<{ address: string; phone: string; email: string }>(
      'SELECT address, phone, email FROM customers WHERE id = ?', [id],
    )
    expect(row).toMatchObject({
      address: '12 Main St', phone: '9876543210', email: 'a@example.com',
    })
  })

  it('hands opening balances back instead of posting them', async () => {
    /* An opening balance is a document and needs a register to be raised at,
       which an import has no business choosing. The caller that has one posts
       them; this only says which and how much. */
    const plan = await planCustomerImport(fx.db, 'name,opening\r\nAnand,5000\r\nBala,\r\n')
    const result = await applyCustomerImport(fx.db, ctx, plan)

    expect(result.opening).toEqual([
      { customerId: expect.any(String), name: 'Anand', amount: rupees(5000) },
    ])
    // Nothing was posted here.
    expect(await fx.db.query('SELECT id FROM bills')).toHaveLength(0)
  })

  it('posts them when the caller does, both ways round', async () => {
    const plan = await planCustomerImport(fx.db, 'name,opening\r\nOwes,5000\r\nHolds,-1200\r\n')
    const result = await applyCustomerImport(fx.db, ctx, plan)

    for (const row of result.opening) {
      await recordOpeningBalance(fx.db, {
        customerId: row.customerId, amount: row.amount as Money,
        registerId: fx.seed.registerId, actorId: fx.adminId,
      })
    }

    const { searchCustomers } = await import('../src/repos/catalog.js')
    const list = await searchCustomers(fx.db, '', 50, { order: 'name' })
    const holds = list.find((c) => c.name === 'Holds')
    const owes = list.find((c) => c.name === 'Owes')

    expect(owes?.outstanding).toBe(rupees(5000))
    expect(holds?.outstanding).toBe(0)
    expect(holds?.advance).toBe(rupees(1200))
  })

  it('records where the row came from', async () => {
    const plan = await planCustomerImport(fx.db, 'name\r\nAnand\r\n')
    await applyCustomerImport(fx.db, ctx, plan)

    const audit = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity = 'customers'`,
    )
    expect(audit?.diff).toContain('csv import')
  })
})

describe('the round trip', () => {
  it('exports only columns the import understands', async () => {
    await makeCustomer(fx.db, 'Anand')
    const headers = (await exportCustomers(fx.db)).split('\r\n')[0]?.split(',') ?? []
    for (const header of headers) {
      expect(CUSTOMER_COLUMNS as readonly string[]).toContain(header)
    }
  })

  it('exports an empty opening column, so a re-import does not post it again', async () => {
    const id = await makeCustomer(fx.db, 'Anand')
    await recordOpeningBalance(fx.db, {
      customerId: id, amount: rupees(5000),
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })

    const plan = await planCustomerImport(fx.db, await exportCustomers(fx.db))
    expect(plan.withOpening).toBe(0)
  })

  it('exports, re-imports, and changes nothing', async () => {
    await makeCustomer(fx.db, 'Anand')
    await makeCustomer(fx.db, 'Bala, and Sons')

    const file = await exportCustomers(fx.db)
    const plan = await planCustomerImport(fx.db, file)
    expect(plan).toMatchObject({ create: 0, update: 2, skip: 0 })

    await applyCustomerImport(fx.db, ctx, plan)
    expect(await exportCustomers(fx.db)).toBe(file)
  })
})

describe('amounts that cannot be right', () => {
  it('refuses a negative credit limit, and a balance with two minus signs', async () => {
    const fx = await freshDb()
    try {
      const plan = await planCustomerImport(fx.db, 'name,creditlimit,opening\nAnand,-500,\nBala,,--200\nChithra,1000,-50\n')
      expect(plan.rows.map((r) => r.problem)).toEqual(['BAD_LIMIT', 'BAD_OPENING', null])
    } finally {
      await fx.db.close()
    }
  })
})
