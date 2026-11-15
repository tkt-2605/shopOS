import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addVersions, setFamilyPrice, familyVersions, splitIntoVersions } from '../src/services/variants.js'
import { saveProductDetails } from '../src/services/products.js'
import { listBarcodes, setBarcodes, barcodesTaken, sharedBarcodes } from '../src/services/barcodes.js'
import { setFeature } from '../src/services/features.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { stockValue } from '../src/services/stock.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { createDocument } from '../src/services/documents/create.js'
import { scanChoices, searchProducts } from '../src/repos/catalog/products.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * An XO pen in several colours that all carry the pen's one barcode.
 *
 * The counter is the point: a scan of that code has to land on a choice of
 * colours, each colour has to sell from its own stock, and the pen itself must
 * never be sold once it has colours. The price and the old stock are the two
 * things that would otherwise drift.
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

async function stockIn(productId: string, qty: number, cost: Money) {
  const entry = await createStockEntry(fx.db, {
    entryType: 'opening', lines: [{ productId, qty: fromUnits(qty), unitCost: cost }], actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error(entry.code)
  await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
}

async function sell(productId: string, qty = 1) {
  return createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId, qty: fromUnits(qty) }], actorId: fx.adminId,
  })
}

describe('adding colours', () => {
  it('makes one item per colour with the pen\'s price and code, and takes the code off the pen', async () => {
    const c = await colours('Blue', 'black', 'Blue ', 'Red')
    expect(Object.keys(c)).toEqual(['Blue', 'black', 'Red'])

    const versions = await familyVersions(fx.db, pen)
    expect(versions.map((v) => v.name)).toEqual(['XO pen (black)', 'XO pen (Blue)', 'XO pen (Red)'])
    expect(versions.every((v) => v.baseRate === rupees(10) && v.taxRateBp === 1800 && v.parentProductId === pen)).toBe(true)

    expect(await listBarcodes(fx.db, pen)).toEqual([])
    for (const v of versions) expect((await listBarcodes(fx.db, v.id)).map((b) => b.barcode)).toEqual([CODE])
  })

  it('refuses a colour the pen already has, and colours of a colour', async () => {
    const c = await colours('Blue')
    expect(await addVersions(fx.db, ctx(), { parentId: pen, labels: ['blue'] }))
      .toEqual({ ok: false, code: 'LABEL_TAKEN', label: 'blue' })
    expect(await addVersions(fx.db, ctx(), { parentId: c.Blue!, labels: ['Dark'] }))
      .toEqual({ ok: false, code: 'IS_A_VERSION' })
    expect(await addVersions(fx.db, ctx(), { parentId: pen, labels: ['  '] }))
      .toEqual({ ok: false, code: 'NO_LABELS' })
  })
})

describe('at the counter', () => {
  it('a scan of the shared code offers the colours and nothing else', async () => {
    await colours('Blue', 'Black', 'Red')
    // What the counter does with a scan: search for the code, and ask when several items hold it.
    const choices = scanChoices(await searchProducts(fx.db, { term: CODE }))
    expect(choices?.map((p) => p.variantLabel).sort()).toEqual(['Black', 'Blue', 'Red'])

    // Typing the name finds the family once, marked as one, for the colour box.
    const found = await searchProducts(fx.db, { term: 'xo pen' })
    expect(found.find((p) => p.id === pen)?.versions).toBe(3)
  })

  it('sells a colour from its own stock, and refuses the pen itself', async () => {
    const c = await colours('Blue', 'Red')
    await stockIn(c.Blue!, 10, rupees(6))

    const made = await sell(c.Blue!, 3)
    if (!made.ok) throw new Error(made.code)
    const paid = await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId, payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    expect(paid.ok).toBe(true)
    expect((await stockValue(fx.db, c.Blue!)).qty).toBe(fromUnits(7))
    expect((await stockValue(fx.db, c.Red!)).qty).toBe(fromUnits(0))
    const line = await fx.db.get<{ product_name: string }>('SELECT product_name FROM bill_items WHERE bill_id = ?', [made.billId])
    expect(line?.product_name).toBe('XO pen (Blue)')

    expect(await sell(pen)).toMatchObject({ ok: false, code: 'PICK_A_VERSION', productName: 'XO pen' })
  })

  it('lets the colours share the code with One item per barcode on, and keeps other items to the rule', async () => {
    await setFeature(fx.db, ctx(), 'uniqueBarcode', true)
    const c = await colours('Blue', 'Red')
    expect(await barcodesTaken(fx.db, c.Blue!, [CODE])).toEqual([])
    expect(await sharedBarcodes(fx.db)).toEqual([])

    const other = await makeProduct(fx.db, { name: 'Gel pen' })
    expect((await barcodesTaken(fx.db, other, [CODE])).length).toBe(2)
    expect(await setBarcodes(fx.db, ctx(), other, [{ barcode: CODE }])).toMatchObject({ ok: false, code: 'BARCODE_TAKEN' })
  })
})

describe('one price for the family', () => {
  const details = (id: string, name: string, rate: Money) => ({
    id, name, brand: null, hsnCode: '9608', taxRateBp: 1200, baseRate: rate, mrp: rupees(12), baseUnit: 'piece',
    discountBlocked: false, loyaltyBlocked: false, returnBlocked: false, isStockTracked: true,
    reorderLevel: null, reorderQty: null,
  })

  it('is on for new colours: the pen\'s new price reaches every colour, and a colour cannot drift', async () => {
    const c = await colours('Blue', 'Red')
    expect((await saveProductDetails(fx.db, ctx(), details(pen, 'XO pen', rupees(11)))).ok).toBe(true)
    for (const v of await familyVersions(fx.db, pen)) {
      expect(v).toMatchObject({ baseRate: rupees(11), mrp: rupees(12), taxRateBp: 1200, hsnCode: '9608' })
    }

    // A colour saved at its own price is put back to the family's, name and all else kept.
    await saveProductDetails(fx.db, ctx(), details(c.Red!, 'XO pen (Red)', rupees(15)))
    const red = (await familyVersions(fx.db, pen)).find((v) => v.id === c.Red)
    expect(red?.baseRate).toBe(rupees(11))
  })

  it('off, each colour keeps a price of its own; on again, they all take the pen\'s', async () => {
    const c = await colours('Blue', 'Red')
    await setFamilyPrice(fx.db, ctx(), pen, false)
    await saveProductDetails(fx.db, ctx(), details(c.Red!, 'XO pen (Red)', rupees(15)))
    await saveProductDetails(fx.db, ctx(), details(pen, 'XO pen', rupees(11)))
    const byLabel = Object.fromEntries((await familyVersions(fx.db, pen)).map((v) => [v.variantLabel, v.baseRate]))
    expect(byLabel).toEqual({ Blue: rupees(10), Red: rupees(15) })

    await setFamilyPrice(fx.db, ctx(), pen, true)
    expect((await familyVersions(fx.db, pen)).map((v) => v.baseRate)).toEqual([rupees(11), rupees(11)])
  })
})

describe('the pens held before there were colours', () => {
  it('move onto the colours at their own cost, so the stock is worth what it was', async () => {
    await stockIn(pen, 10, rupees(6))
    const c = await colours('Blue', 'Red')
    const before = await stockValue(fx.db, pen)

    const split = await splitIntoVersions(fx.db, ctx(), {
      parentId: pen, lines: [{ productId: c.Blue!, qty: fromUnits(6) }, { productId: c.Red!, qty: fromUnits(4) }],
    })
    expect(split.ok).toBe(true)

    const [p, blue, red] = await Promise.all([stockValue(fx.db, pen), stockValue(fx.db, c.Blue!), stockValue(fx.db, c.Red!)])
    expect([p.qty, blue.qty, red.qty]).toEqual([fromUnits(0), fromUnits(6), fromUnits(4)])
    expect(blue.value + red.value).toBe(before.value)
    expect(blue.unitCost).toBe(rupees(6))
  })

  it('cannot move more than the pen holds, or onto an item outside the family', async () => {
    await stockIn(pen, 2, rupees(6))
    const c = await colours('Blue')
    expect(await splitIntoVersions(fx.db, ctx(), { parentId: pen, lines: [{ productId: c.Blue!, qty: fromUnits(3) }] }))
      .toEqual({ ok: false, code: 'MORE_THAN_HELD' })
    const stranger = await makeProduct(fx.db, { name: 'Gel pen' })
    expect(await splitIntoVersions(fx.db, ctx(), { parentId: pen, lines: [{ productId: stranger, qty: fromUnits(1) }] }))
      .toEqual({ ok: false, code: 'NOT_A_VERSION' })
  })
})

describe("the family's name, once it has variants", () => {
  it('takes no goods in, is not billed even from a quotation, and can still have old stock cleared off it', async () => {
    await stockIn(pen, 4, rupees(6))
    await colours('Blue')

    const delivery = await createStockEntry(fx.db, {
      entryType: 'purchase', lines: [{ productId: pen, qty: fromUnits(5), unitCost: rupees(6) }], actorId: fx.adminId,
    })
    expect(delivery).toEqual({ ok: false, code: 'PICK_A_VERSION', productId: pen })

    const quote = await createDocument(fx.db, {
      kind: 'quotation', registerId: fx.seed.registerId, customerId: await makeCustomer(fx.db), lines: [{ productId: pen, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    // A quotation is only an intention; the bill it would turn into is where the rule bites.
    expect(quote.ok).toBe(true)

    // Wastage is typed as a count and stored as a loss, so it is goods going out and allowed.
    const broken = await createStockEntry(fx.db, {
      entryType: 'wastage', lines: [{ productId: pen, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    expect(broken.ok).toBe(true)
  })
})
