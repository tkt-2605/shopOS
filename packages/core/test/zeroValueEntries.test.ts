import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { documentsWithoutEntries } from '../src/services/ledger.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * "Some documents are not in the books" is for a document that should have
 * entries and has none. A stock entry worth nothing -- goods received with no
 * cost, no bill and no tax -- has none to post, and is not missing. Found at a
 * shop whose Needs attention listed two such entries for good.
 */

let fx: Fixture
let tape: string

beforeEach(async () => {
  fx = await freshDb()
  tape = await makeProduct(fx.db, { name: 'Tape', taxRateBp: 0 })
})
afterEach(async () => { await fx.db.close() })

async function entry(entryType: 'purchase' | 'opening' | 'adjustment', units: number, unitCost: Money): Promise<string> {
  const made = await createStockEntry(fx.db, {
    entryType, reference: '', actorId: fx.adminId,
    lines: [{ productId: tape, qty: fromUnits(units), unitCost, taxRateBp: 0 }],
  })
  if (!made.ok) throw new Error(made.code)
  const done = await submitStockEntry(fx.db, { entryId: made.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
  return made.entryId
}

/** The books lose a document's entries, as a till that never posted them would leave it. */
async function loseEntries(id: string) {
  await fx.db.execute('DROP TRIGGER IF EXISTS gl_entries_is_append_only_del')
  await fx.db.execute(`DELETE FROM gl_entries WHERE voucher_type = 'stock_entry' AND voucher_id = ?`, [id])
}

const flagged = async (id: string) => (await documentsWithoutEntries(fx.db)).includes(`stock_entry:${id}`)

describe('a stock entry worth nothing', () => {
  it('is not called missing from the books, whatever kind it is', async () => {
    for (const kind of ['purchase', 'opening', 'adjustment'] as const) {
      expect(await flagged(await entry(kind, 5, 0 as Money))).toBe(false)
    }
  })
})

describe('a stock entry with a value', () => {
  it('is still called missing when its entries are gone', async () => {
    const id = await entry('purchase', 5, rupees(10))
    expect(await flagged(id)).toBe(false)
    await loseEntries(id)
    expect(await flagged(id)).toBe(true)
  })

  it('counts goods going out at the shelf’s cost, though no cost was typed', async () => {
    await entry('purchase', 10, rupees(10))
    const out = await entry('adjustment', -2, 0 as Money)
    expect(await flagged(out)).toBe(false)
    await loseEntries(out)
    expect(await flagged(out)).toBe(true)
  })
})
