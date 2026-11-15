import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addVersions, editVersion, familyVersions, familyTotals, setFamilyPrice } from '../src/services/variants.js'
import { saveProductDetails } from '../src/services/products.js'
import { setFeature } from '../src/services/features.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { planImport, applyImport } from '../src/services/import.js'
import { exportCatalogue } from '../src/services/catalogueExport.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * A family edited from its Variants tab, listed in Inventory, and carried
 * through a catalogue file -- the three places the item page leans on core.
 */

const CODE = '8901234567890'
let fx: Fixture
let pen: string
const ctx = () => ({ actorId: fx.adminId })

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'XO pen', baseRate: rupees(10), taxRateBp: 1800, barcode: CODE })
})
afterEach(async () => { await fx.db.close() })

async function colours(...labels: string[]) {
  const made = await addVersions(fx.db, ctx(), { parentId: pen, labels })
  if (!made.ok) throw new Error(made.code)
  return Object.fromEntries(made.created.map((c) => [c.label, c.id])) as Record<string, string>
}
const byLabel = async (opts = {}) => Object.fromEntries((await familyVersions(fx.db, pen, opts)).map((v) => [v.variantLabel, v]))

describe('a variant edited from its family', () => {
  it('is renamed with its label, and refuses a label its family already has', async () => {
    const c = await colours('Blue', 'Red')
    expect(await editVersion(fx.db, ctx(), { productId: c.Red!, label: 'Green' })).toEqual({ ok: true })
    expect((await byLabel()).Green?.name).toBe('XO pen (Green)')
    expect(await editVersion(fx.db, ctx(), { productId: c.Blue!, label: 'green' })).toEqual({ ok: false, code: 'LABEL_TAKEN', label: 'green' })
  })

  it('takes a price of its own only when the family is not priced as one', async () => {
    const c = await colours('Blue', 'Red')
    expect(await editVersion(fx.db, ctx(), { productId: c.Red!, baseRate: rupees(12) })).toEqual({ ok: false, code: 'FAMILY_PRICED' })
    await setFamilyPrice(fx.db, ctx(), pen, false)
    expect(await editVersion(fx.db, ctx(), { productId: c.Red!, baseRate: rupees(12) })).toEqual({ ok: true })
    expect((await byLabel()).Red?.baseRate).toBe(rupees(12))
  })

  it('goes out of use and comes back, leaving the counter only while it is out', async () => {
    const c = await colours('Blue', 'Red')
    await editVersion(fx.db, ctx(), { productId: c.Red!, active: false })
    expect(Object.keys(await byLabel())).toEqual(['Blue'])
    expect(Object.keys(await byLabel({ includeRetired: true }))).toEqual(['Blue', 'Red'])
    await editVersion(fx.db, ctx(), { productId: c.Red!, active: true })
    expect(Object.keys(await byLabel())).toEqual(['Blue', 'Red'])
  })

  it('is renamed when its family is', async () => {
    await colours('Blue')
    await saveProductDetails(fx.db, ctx(), {
      id: pen, name: 'XO gel pen', brand: null, hsnCode: null, taxRateBp: 1800, baseRate: rupees(10), mrp: null,
      baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false, returnBlocked: false, isStockTracked: true,
      reorderLevel: null, reorderQty: null,
    })
    expect((await byLabel()).Blue?.name).toBe('XO gel pen (Blue)')
  })
})

describe('a family in the Inventory list', () => {
  it('counts its variants in use and the stock they hold together', async () => {
    const c = await colours('Blue', 'Red', 'Green')
    const entry = await createStockEntry(fx.db, {
      entryType: 'opening', actorId: fx.adminId,
      lines: [{ productId: c.Blue!, qty: fromUnits(6), unitCost: rupees(6) }, { productId: c.Red!, qty: fromUnits(4), unitCost: rupees(6) }],
    })
    if (!entry.ok) throw new Error(entry.code)
    await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
    await editVersion(fx.db, ctx(), { productId: c.Green!, active: false })
    expect((await familyTotals(fx.db)).get(pen)).toEqual({ count: 2, qty: fromUnits(10) })
  })
})

describe('a family in a catalogue file', () => {
  it('exports each variant beside its family and imports back the same', async () => {
    await colours('Blue', 'Red')
    const file = await exportCatalogue(fx.db)
    expect(file).toContain('XO pen (Blue)')
    expect(file.split('\r\n')[0]).toMatch(/,variantof,variant$/)

    const plan = await planImport(fx.db, file)
    expect(plan).toMatchObject({ create: 0, update: 3, skip: 0 })
    await applyImport(fx.db, ctx(), plan)
    expect(await exportCatalogue(fx.db)).toBe(file)
  })

  it('makes a family from a file into a shop that has none, on one shared code', async () => {
    const file = [
      'name,barcode,rate,variantof,variant',
      'Gel pen,,15,,',
      `Gel pen Blue,${CODE}0,15,Gel pen,Blue`,
      `Gel pen Black,${CODE}0,15,Gel pen,Black`,
    ].join('\n')
    const plan = await planImport(fx.db, file)
    expect(plan).toMatchObject({ create: 3, skip: 0 })
    await applyImport(fx.db, ctx(), plan)

    const [gel] = await fx.db.query<{ id: string }>("SELECT id FROM products WHERE name = 'Gel pen'")
    const variants = await familyVersions(fx.db, gel!.id)
    expect(variants.map((v) => v.name)).toEqual(['Gel pen (Black)', 'Gel pen (Blue)'])
    expect(variants.every((v) => v.barcode === `${CODE}0`)).toBe(true)
  })

  it('refuses a line whose family is nowhere, or that names no variant', async () => {
    const plan = await planImport(fx.db, ['name,variantof,variant', 'Ghost Blue,Ghost pen,Blue', 'Odd one,XO pen,'].join('\n'))
    expect(plan.rows.map((r) => r.problem)).toEqual(['NO_FAMILY', 'NO_VARIANT'])
  })

  it('lets a family share its code with One item per barcode on, and no one else', async () => {
    await setFeature(fx.db, ctx(), 'uniqueBarcode', true)
    await colours('Blue', 'Red')
    const plan = await planImport(fx.db, await exportCatalogue(fx.db))
    expect(plan.skip).toBe(0)

    const stranger = await planImport(fx.db, ['name,barcode', `Gel pen,${CODE}`].join('\n'))
    // Refused before the switch is even asked: the code is the family's, and this name is none of its variants.
    expect(stranger.rows[0]?.problem).toBe('BARCODE_SHARED')
  })
})
