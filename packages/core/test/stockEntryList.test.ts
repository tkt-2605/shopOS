import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStockEntry, submitStockEntry, cancelStockEntry, type StockEntryType } from '../src/services/stockEntry.js'
import { listStockEntries, loadStockEntry } from '../src/repos/stockEntries.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Every stock entry in one list, narrowed by dates, kind, supplier, state and
 * a word (`repos/stockEntries.ts`).
 */

let fx: Fixture
let paper: string
let tape: string
let mills: string

beforeEach(async () => {
  fx = await freshDb()
  paper = await makeProduct(fx.db, { name: 'A4 Copier Paper', taxRateBp: 0 })
  tape = await makeProduct(fx.db, { name: 'Binding Tape', taxRateBp: 0 })
  mills = newId()
  const now = new Date().toISOString()
  await fx.db.execute(`INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, [mills, 'Paper Mills', now, now])
})
afterEach(async () => { await fx.db.close() })

async function entry(entryType: StockEntryType, postingDate: string, lines: [string, number, Money][], extra: {
  supplierId?: string; supplierInvoiceNo?: string; reference?: string
} = {}): Promise<string> {
  const made = await createStockEntry(fx.db, {
    entryType, postingDate, reference: extra.reference ?? '', actorId: fx.adminId,
    ...(extra.supplierId ? { supplierId: extra.supplierId } : {}),
    ...(extra.supplierInvoiceNo ? { supplierInvoiceNo: extra.supplierInvoiceNo } : {}),
    lines: lines.map(([productId, units, unitCost]) => ({ productId, qty: fromUnits(units), unitCost, taxRateBp: 0 })),
  })
  if (!made.ok) throw new Error(made.code)
  const done = await submitStockEntry(fx.db, { entryId: made.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
  return made.entryId
}

const month = { from: '2026-10-01', to: '2026-10-31' }

describe('the list of stock entries', () => {
  beforeEach(async () => {
    await entry('purchase', '2026-10-05', [[paper, 10, rupees(250)], [tape, 4, rupees(30)]], { supplierId: mills, supplierInvoiceNo: 'PM-881' })
    await entry('opening', '2026-10-01', [[tape, 20, rupees(28)]])
    await entry('wastage', '2026-10-12', [[paper, 2, 0 as Money]], { reference: 'rain damage' })
    await entry('purchase', '2026-09-20', [[paper, 5, rupees(240)]], { supplierId: mills })
  })

  it('lists the month newest first, each with its items, what it moved and what it was worth', async () => {
    const rows = await listStockEntries(fx.db, month)
    expect(rows.map((r) => [r.entryType, r.postingDate])).toEqual([
      ['wastage', '2026-10-12'], ['purchase', '2026-10-05'], ['opening', '2026-10-01'],
    ])
    expect(rows[1]).toMatchObject({
      supplierName: 'Paper Mills', supplierInvoiceNo: 'PM-881', lineCount: 2,
      items: 'A4 Copier Paper, Binding Tape', netQty: fromUnits(14), value: rupees(2620),
    })
    // Two reams going out with no cost typed leave at the shelf's, and the value says so.
    expect(rows[0]!.netQty).toBe(fromUnits(-2))
    expect(rows[0]!.value).toBeLessThan(0)
  })

  it('narrows to one kind, one supplier, or a word from the number, the invoice, the reference or an item', async () => {
    expect((await listStockEntries(fx.db, { ...month, entryType: 'opening' })).map((r) => r.entryType)).toEqual(['opening'])
    expect(await listStockEntries(fx.db, { ...month, supplierId: mills })).toHaveLength(1)
    expect(await listStockEntries(fx.db, { from: '2026-09-01', to: '2026-10-31', supplierId: mills })).toHaveLength(2)
    expect((await listStockEntries(fx.db, { ...month, search: 'pm-881' })).map((r) => r.supplierInvoiceNo)).toEqual(['PM-881'])
    expect((await listStockEntries(fx.db, { ...month, search: 'RAIN' })).map((r) => r.entryType)).toEqual(['wastage'])
    expect((await listStockEntries(fx.db, { ...month, search: 'binding' })).map((r) => r.entryType)).toEqual(['purchase', 'opening'])
    expect(await listStockEntries(fx.db, { ...month, search: '100%' })).toEqual([])
    expect(await listStockEntries(fx.db, { ...month, search: 'mills' })).toHaveLength(1)
  })

  it('keeps cancelled entries out until asked for, then shows what they had moved', async () => {
    const [wastage] = await listStockEntries(fx.db, { ...month, entryType: 'wastage' })
    await cancelStockEntry(fx.db, { entryId: wastage!.id, actorId: fx.adminId })
    expect(await listStockEntries(fx.db, { ...month, entryType: 'wastage' })).toEqual([])
    const [cancelled] = await listStockEntries(fx.db, { ...month, entryType: 'wastage', state: 'cancelled' })
    expect(cancelled).toMatchObject({ docstatus: 2, netQty: fromUnits(-2) })
    expect(await listStockEntries(fx.db, { ...month, state: 'all' })).toHaveLength(3)
  })
})

describe('one stock entry', () => {
  it('has its lines, each with its cost, its tax and what it moved', async () => {
    const id = await entry('purchase', '2026-10-05', [[paper, 10, rupees(250)], [tape, 4, rupees(30)]], { supplierId: mills })
    const view = await loadStockEntry(fx.db, id)
    expect(view).toMatchObject({ entryType: 'purchase', supplierName: 'Paper Mills', lineCount: 2, value: rupees(2620) })
    expect(view!.lines.map((l) => [l.productName, l.qty, l.unitCost, l.value])).toEqual([
      ['A4 Copier Paper', fromUnits(10), rupees(250), rupees(2500)],
      ['Binding Tape', fromUnits(4), rupees(30), rupees(120)],
    ])
  })

  it('is nothing for an id the shop does not have', async () => {
    expect(await loadStockEntry(fx.db, newId())).toBeNull()
  })
})
