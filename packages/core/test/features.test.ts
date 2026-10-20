import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { loadFeatures, isOn, setFeature } from '../src/services/features.js'
import { setUnits, setLadder } from '../src/services/pricing.js'
import { setBarcodes } from '../src/services/barcodes.js'
import { searchProducts, findByBarcode } from '../src/repos/catalog.js'
import { resolveLinePrice, pricingContextFor } from '../src/repos/pricing.js'
import { rowsToRungs, type LadderRow } from '../src/domain/ladder.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

function rungs(text: string) {
  const rows: LadderRow[] = text.split(',').map((part) => {
    const [minQty, rate] = part.split('=')
    return { minQty: (minQty ?? '').trim(), rate: (rate ?? '').trim() }
  })
  const parsed = rowsToRungs(rows)
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.rungs
}

describe('what a shop starts with', () => {
  /* The extras are off until asked for, batches too since 062. The phone rule
     is the exception and deliberately so: entering the same customer twice is a mistake, not a
     capability, so a fresh shop is protected from it without being asked. One item per barcode starts off: a
     shared code is a real thing (069), and the scan asks. */
  it('starts simple, but already refusing a duplicate phone number', async () => {
    expect(await loadFeatures(fx.db)).toEqual({
      multiBarcode: false, tieredPricing: false, uniquePhone: true, uniqueBarcode: false, batchExpiry: false,
    })
  })

  /* The switch must not be a way to lose what a shop is already doing. These two
     run the schema up to the version before the switches existed, put real data
     in, and then let the migration decide. */
  it('finds a shop already using several barcodes and leaves it using them', async () => {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version < 11))

    const now = new Date().toISOString()
    const p = newId()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES (?, 'Pen', 1000, 0, ?, ?)`, [p, now, now],
    )
    for (const code of ['111', '222']) {
      await db.execute(
        `INSERT INTO product_barcodes (id, product_id, barcode, is_primary, created_at)
         VALUES (?, ?, ?, 0, ?)`, [newId(), p, code, now],
      )
    }

    await migrate(db, MIGRATIONS)
    expect(await isOn(db, 'multiBarcode')).toBe(true)
    await db.close()
  })

  it('finds a shop already using price breaks and leaves it using them', async () => {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version < 11))

    const now = new Date().toISOString()
    const p = newId()
    const list = newId()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES (?, 'Pen', 1000, 0, ?, ?)`, [p, now, now],
    )
    await db.execute(
      `INSERT INTO price_lists (id, name, is_default, created_at, updated_at) VALUES (?, 'Retail', 1, ?, ?)`,
      [list, now, now],
    )
    const rungs: [number, number][] = [[0, 1000], [100_000, 900]]
    for (const [minQty, rate] of rungs) {
      await db.execute(
        `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, created_at, updated_at)
         VALUES (?, ?, ?, 'piece', ?, ?, ?, ?)`,
        [newId(), p, list, minQty, rate, now, now],
      )
    }

    await migrate(db, MIGRATIONS)
    expect(await isOn(db, 'tieredPricing')).toBe(true)
    await db.close()
  })

  /* One rung is a price, not a ladder. A shop with a price list but no breaks
     should not be handed an editor it never asked for. */
  it('does not count a single price as a ladder', async () => {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version < 11))

    const now = new Date().toISOString()
    const p = newId()
    const list = newId()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES (?, 'Pen', 1000, 0, ?, ?)`, [p, now, now],
    )
    await db.execute(
      `INSERT INTO price_lists (id, name, is_default, created_at, updated_at) VALUES (?, 'Retail', 1, ?, ?)`,
      [list, now, now],
    )
    await db.execute(
      `INSERT INTO item_prices (id, product_id, price_list_id, sale_unit, min_qty, rate, created_at, updated_at)
       VALUES (?, ?, ?, 'piece', 0, 950, ?, ?)`,
      [newId(), p, list, now, now],
    )

    await migrate(db, MIGRATIONS)
    expect(await isOn(db, 'tieredPricing')).toBe(false)
    await db.close()
  })
})

describe('turning one on or off', () => {
  it('is written down with everything else that changed', async () => {
    await setFeature(fx.db, ctx(), 'tieredPricing', true)

    const row = await fx.db.get<{ action: string; diff: string }>(
      `SELECT action, diff FROM audit_log WHERE entity = 'settings' AND entity_id = 'feature_tiered_pricing'`,
    )
    expect(row?.action).toBe('update')
    expect(row?.diff).toContain('Quantity price breaks')
  })

  it('says nothing when nothing changed', async () => {
    await setFeature(fx.db, ctx(), 'tieredPricing', false)
    const rows = await fx.db.query(`SELECT id FROM audit_log WHERE entity = 'settings'`)
    expect(rows).toHaveLength(0)
  })
})

describe('a ladder with quantity breaks switched off', () => {
  async function penWithLadder(): Promise<string> {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
    await setUnits(fx.db, ctx(), p, [{ saleUnit: 'box', baseUnits: fromUnits(12) }])
    await setFeature(fx.db, ctx(), 'tieredPricing', true)
    const saved = await setLadder(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rungs: rungs('1=10, 10=9, 50=8'),
    })
    if (!saved.ok) throw new Error(saved.code)
    return p
  }

  async function rateFor(productId: string, units: number) {
    const pricing = await pricingContextFor(fx.db, null)
    return (await resolveLinePrice(fx.db, pricing, {
      productId, saleUnit: 'piece', qty: fromUnits(units),
    })).rate
  }

  /* Otherwise a shop turns the feature off and goes on being billed by a ladder
     it can no longer see, which is worse than never having had one. */
  it('stops charging by the quantity', async () => {
    const p = await penWithLadder()
    expect(await rateFor(p, 50)).toBe(rupees(8))

    await setFeature(fx.db, ctx(), 'tieredPricing', false)
    expect(await rateFor(p, 50)).toBe(rupees(10))
    expect(await rateFor(p, 1)).toBe(rupees(10))
  })

  it('keeps the rungs, and finds them again when it is switched back on', async () => {
    const p = await penWithLadder()
    await setFeature(fx.db, ctx(), 'tieredPricing', false)

    const still = await fx.db.query(
      `SELECT id FROM item_prices WHERE product_id = ? AND deleted_at IS NULL`, [p],
    )
    expect(still).toHaveLength(3)

    await setFeature(fx.db, ctx(), 'tieredPricing', true)
    expect(await rateFor(p, 50)).toBe(rupees(8))
  })
})

describe('a barcode already stuck on a shelf', () => {
  /* The switch decides what a person is asked to fill in. It must never decide
     whether a code the shop has printed is recognised — a scan that stops
     finding its item is the worst thing this switch could do. */
  it('goes on finding its item with the switch off', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', barcode: '8901111111111' })
    await setFeature(fx.db, ctx(), 'multiBarcode', true)
    const saved = await setBarcodes(fx.db, ctx(), p, [
      { barcode: '8901111111111' }, { barcode: 'OLD-PACK-77' },
    ])
    expect(saved.ok).toBe(true)

    await setFeature(fx.db, ctx(), 'multiBarcode', false)

    expect((await findByBarcode(fx.db, 'OLD-PACK-77'))?.id).toBe(p)
    expect((await searchProducts(fx.db, { term: 'OLD-PACK-77' }))[0]?.id).toBe(p)
  })
})
