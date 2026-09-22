import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  planSupplierImport, applySupplierImport, exportSuppliers, SUPPLIER_COLUMNS,
} from '../src/services/supplierImport.js'
import { createSupplier, supplierSummaries, setSupplierOpening } from '../src/services/suppliers.js'
import { rupees, type Money } from '../src/money.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * The supplier list, arriving as a spreadsheet.
 *
 * The interesting difference from the customer import is that the balance
 * carried over is applied here rather than handed back: a supplier's is a
 * column, and a customer's is a document that needs a register to be raised
 * at. Two features that look the same and are stored differently.
 */

const ctx = { actorId: 'owner' }

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function supplier(name: string): Promise<string> {
  const made = await createSupplier(fx.db, { name, actorId: ctx.actorId })
  if (!made.ok) throw new Error(made.code)
  return made.supplierId
}

async function summaryOf(id: string) {
  return (await supplierSummaries(fx.db)).find((s) => s.id === id)
}

describe('planning', () => {
  it('writes nothing', async () => {
    await planSupplierImport(fx.db, 'name,phone\r\nRamesh,9876543210\r\n')
    expect(await fx.db.query('SELECT id FROM suppliers')).toHaveLength(0)
  })

  it('counts what it would add and change', async () => {
    await supplier('Ramesh Traders')
    const plan = await planSupplierImport(fx.db, 'name\r\nRamesh Traders\r\nKumar Agencies\r\n')
    expect(plan).toMatchObject({ create: 1, update: 1, skip: 0 })
  })

  it('matches on GSTIN before phone or name', async () => {
    const id = await supplier('Old name')
    await fx.db.execute('UPDATE suppliers SET gstin = ? WHERE id = ?', ['27AAPFU0939F1ZV', id])

    const plan = await planSupplierImport(fx.db,
      'name,gstin\r\nNew name,27AAPFU0939F1ZV\r\n')
    expect(plan.rows[0]).toMatchObject({ action: 'update', supplierId: id })
  })

  it('refuses a GSTIN and a phone that point at two different suppliers', async () => {
    const one = await supplier('One')
    const two = await supplier('Two')
    await fx.db.execute('UPDATE suppliers SET gstin = ? WHERE id = ?', ['27AAPFU0939F1ZV', one])
    await fx.db.execute('UPDATE suppliers SET phone = ? WHERE id = ?', ['9876543210', two])

    const plan = await planSupplierImport(fx.db,
      'name,gstin,phone\r\nX,27AAPFU0939F1ZV,9876543210\r\n')
    expect(plan.rows[0]?.problem).toBe('GSTIN_TAKEN')
  })

  it('checks the GSTIN and the date rather than storing rubbish', async () => {
    const plan = await planSupplierImport(fx.db,
      'name,gstin\r\nGood,27AAPFU0939F1ZV\r\nBad,NOPE\r\n')
    expect(plan.rows.map((r) => r.problem)).toEqual([null, 'BAD_GSTIN'])

    const dates = await planSupplierImport(fx.db,
      'name,openingasof\r\nA,2026-03-31\r\nB,31-03-2026\r\n')
    expect(dates.rows.map((r) => r.problem)).toEqual([null, 'BAD_DATE'])
  })

  it('takes a negative balance, for an advance already paid', async () => {
    const plan = await planSupplierImport(fx.db, 'name,opening\r\nA,12000\r\nB,-3000\r\n')
    expect(plan.rows.map((r) => r.opening)).toEqual([rupees(12_000), -rupees(3000)])
    expect(plan.withOpening).toBe(2)
  })

  it('refuses the same name, GSTIN or phone twice in one file', async () => {
    const plan = await planSupplierImport(fx.db,
      'name,phone\r\nA,111\r\nB,111\r\nA,222\r\n')
    expect(plan.rows.map((r) => r.problem)).toEqual([null, 'PHONE_TWICE', 'NAME_TWICE'])
  })

  it('names the line Excel shows, past a blank row', async () => {
    const plan = await planSupplierImport(fx.db, 'name,gstin\r\nA,\r\n\r\nB,NOPE\r\n')
    expect(plan.rows.find((r) => r.problem === 'BAD_GSTIN')?.line).toBe(4)
  })
})

describe('applying', () => {
  it('creates, with the balance carried over', async () => {
    /* Applied here, unlike the customer side: a supplier opening balance is
       a column, so there is no document and no register to choose. */
    const plan = await planSupplierImport(fx.db,
      'name,opening,openingasof\r\nRamesh Traders,12000,2026-03-31\r\n')
    expect(await applySupplierImport(fx.db, ctx, plan))
      .toEqual({ created: 1, updated: 0, skipped: 0 })

    const row = (await supplierSummaries(fx.db))[0]
    expect(row).toMatchObject({
      name: 'Ramesh Traders',
      openingBalance: rupees(12_000),
      openingAsOf: '2026-03-31',
    })
  })

  it('leaves a blank cell alone rather than clearing it', async () => {
    const id = await supplier('Ramesh Traders')
    await fx.db.execute('UPDATE suppliers SET gstin = ?, address = ? WHERE id = ?',
      ['27AAPFU0939F1ZV', '12 Market Rd', id])

    const plan = await planSupplierImport(fx.db, 'name,phone\r\nRamesh Traders,9876543210\r\n')
    await applySupplierImport(fx.db, ctx, plan)

    const row = await summaryOf(id)
    expect(row).toMatchObject({
      gstin: '27AAPFU0939F1ZV', address: '12 Market Rd', phone: '9876543210',
    })
  })

  it('dates a balance given without one to today', async () => {
    const plan = await planSupplierImport(fx.db, 'name,opening\r\nRamesh,500\r\n')
    await applySupplierImport(fx.db, ctx, plan)
    expect((await supplierSummaries(fx.db))[0]?.openingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('records where the row came from', async () => {
    const plan = await planSupplierImport(fx.db, 'name\r\nRamesh\r\n')
    await applySupplierImport(fx.db, ctx, plan)

    const audit = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity = 'suppliers'`,
    )
    expect(audit?.diff).toContain('csv import')
  })
})

describe('the round trip', () => {
  it('exports only columns the import understands', async () => {
    await supplier('Ramesh Traders')
    const headers = (await exportSuppliers(fx.db)).split('\r\n')[0]?.split(',') ?? []
    for (const header of headers) {
      expect(SUPPLIER_COLUMNS as readonly string[]).toContain(header)
    }
  })

  it('leaves never-asked blank rather than writing a zero', async () => {
    /* Writing 0.00 would turn "nobody has said" into "answered nothing" on
       the way back in, and those are different things. */
    await supplier('Never asked')
    const plan = await planSupplierImport(fx.db, await exportSuppliers(fx.db))
    expect(plan.withOpening).toBe(0)
    expect(plan.rows[0]?.opening).toBeNull()
  })

  it('exports, re-imports, and changes nothing', async () => {
    const id = await supplier('Ramesh Traders')
    await setSupplierOpening(fx.db, ctx, {
      supplierId: id, amount: rupees(12_000), asOf: '2026-03-31',
    })
    await supplier('Kumar, and Sons')

    const file = await exportSuppliers(fx.db)
    const plan = await planSupplierImport(fx.db, file)
    expect(plan).toMatchObject({ create: 0, update: 2, skip: 0 })

    await applySupplierImport(fx.db, ctx, plan)
    expect(await exportSuppliers(fx.db)).toBe(file)
  })
})

describe('ordering the list', () => {
  async function owing(name: string, amount: Money) {
    const id = await supplier(name)
    await setSupplierOpening(fx.db, ctx, { supplierId: id, amount })
    return id
  }

  it('puts the biggest debt first', async () => {
    await owing('Anand', rupees(100))
    await owing('Bala', rupees(9000))
    await owing('Chandra', rupees(2500))

    const list = await supplierSummaries(fx.db, { order: 'owed' })
    expect(list.map((s) => s.name)).toEqual(['Bala', 'Chandra', 'Anand'])
  })

  it('defaults to name', async () => {
    await owing('Chandra', rupees(9000))
    await owing('Anand', rupees(100))
    expect((await supplierSummaries(fx.db)).map((s) => s.name)).toEqual(['Anand', 'Chandra'])
  })

  it('breaks a tie by name rather than leaving it to the planner', async () => {
    await owing('Zubair', rupees(500))
    await owing('Anand', rupees(500))

    const once = await supplierSummaries(fx.db, { order: 'owed' })
    const again = await supplierSummaries(fx.db, { order: 'owed' })
    expect(once.map((s) => s.name)).toEqual(['Anand', 'Zubair'])
    expect(again.map((s) => s.name)).toEqual(once.map((s) => s.name))
  })

  it('counts a supplier nothing has come from as the quietest', async () => {
    await supplier('Never delivered')
    await supplier('Also never')
    const list = await supplierSummaries(fx.db, { order: 'quietest' })
    expect(list.map((s) => s.name)).toEqual(['Also never', 'Never delivered'])
  })
})
