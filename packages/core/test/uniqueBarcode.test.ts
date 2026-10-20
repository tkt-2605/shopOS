import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listBarcodes, setBarcodes, barcodesTaken, sharedBarcodes } from '../src/services/barcodes.js'
import { setFeature } from '../src/services/features.js'
import { planImport } from '../src/services/import.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * One item per barcode (`uniqueBarcode`): a shop that wants every code to
 * mean one item can say so, and a code another item has is then refused in
 * the form and in a file. Off, a code may be shared (069) and the scan asks.
 */

let fx: Fixture
let small: string
let large: string

beforeEach(async () => {
  fx = await freshDb()
  small = await makeProduct(fx.db, { name: 'Glue 50ml' })
  large = await makeProduct(fx.db, { name: 'Glue 100ml' })
  await setBarcodes(fx.db, ctx(), small, [{ barcode: '8901234567890' }])
})
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })
const unique = (on: boolean) => setFeature(fx.db, ctx(), 'uniqueBarcode', on)
const primaryOf = async (id: string) =>
  (await fx.db.get<{ b: string | null }>('SELECT barcode AS b FROM products WHERE id = ?', [id]))?.b ?? null

describe('with the switch off', () => {
  it('lets a code go on a second item, as since 069', async () => {
    expect(await setBarcodes(fx.db, ctx(), large, [{ barcode: '8901234567890' }])).toMatchObject({ ok: true })
    expect(await barcodesTaken(fx.db, large, ['8901234567890'])).toEqual([])
  })
})

describe('with the switch on', () => {
  beforeEach(async () => { await unique(true) })

  it('refuses a code another item has, says which, and writes nothing', async () => {
    await setBarcodes(fx.db, ctx(), large, [{ barcode: 'OWN-1' }])
    const result = await setBarcodes(fx.db, ctx(), large, [{ barcode: 'OWN-2' }, { barcode: '8901234567890' }])
    expect(result).toEqual({
      ok: false, code: 'BARCODE_TAKEN',
      taken: [{ barcode: '8901234567890', productId: small, productName: 'Glue 50ml' }],
    })
    expect((await listBarcodes(fx.db, large)).map((b) => b.barcode)).toEqual(['OWN-1'])
    expect(await primaryOf(large)).toBe('OWN-1')
  })

  it('reads past spaces in the code it is asked about', async () => {
    expect(await setBarcodes(fx.db, ctx(), large, [{ barcode: ' 8901234567890 ' }])).toMatchObject({ code: 'BARCODE_TAKEN' })
  })

  it('answers for an item not saved yet', async () => {
    expect(await barcodesTaken(fx.db, null, ['8901234567890', 'NEW'])).toEqual([
      { barcode: '8901234567890', productId: small, productName: 'Glue 50ml' },
    ])
    expect(await barcodesTaken(fx.db, null, ['', '  '])).toEqual([])
  })

  it('lets an item save its own code again, and give it up', async () => {
    expect(await setBarcodes(fx.db, ctx(), small, [{ barcode: '8901234567890' }, { barcode: 'TAG-1' }])).toMatchObject({ ok: true })
    expect(await setBarcodes(fx.db, ctx(), small, [])).toMatchObject({ ok: true })
    expect(await setBarcodes(fx.db, ctx(), large, [{ barcode: '8901234567890' }])).toMatchObject({ ok: true })
  })

  it('does not count a code on an item taken out of the catalogue', async () => {
    await fx.db.execute('UPDATE products SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), small])
    expect(await setBarcodes(fx.db, ctx(), large, [{ barcode: '8901234567890' }])).toMatchObject({ ok: true })
  })

  it('leaves a code shared from before alone, so both items can still be saved', async () => {
    await unique(false)
    await setBarcodes(fx.db, ctx(), large, [{ barcode: '8901234567890' }])
    await unique(true)
    expect(await setBarcodes(fx.db, ctx(), large, [{ barcode: '8901234567890' }, { barcode: 'TAG-2' }])).toMatchObject({ ok: true })
    expect(await setBarcodes(fx.db, ctx(), small, [{ barcode: '8901234567890' }])).toMatchObject({ ok: true })
    expect(await sharedBarcodes(fx.db)).toEqual([{
      barcode: '8901234567890',
      items: [{ productId: large, productName: 'Glue 100ml' }, { productId: small, productName: 'Glue 50ml' }],
    }])
  })

  it('is written to the audit trail when switched', async () => {
    const row = await fx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'settings' AND entity_id = 'feature_unique_barcode'`,
    )
    expect(row?.n).toBe(1)
  })
})

describe('a catalogue file', () => {
  const file = (...rows: string[]) => ['name,barcode,rate', ...rows].join('\n')

  it('with the switch off, puts a code the file gives two new items on both', async () => {
    const plan = await planImport(fx.db, file('Tape small,555,10', 'Tape large,555,20'))
    expect(plan.rows.map((r) => r.problem)).toEqual([null, null])
  })

  it('with the switch on, gives a code in the file to the first item only', async () => {
    await unique(true)
    const plan = await planImport(fx.db, file('Tape small,555,10', 'Tape large,555,20', 'Tape roll,556,30'))
    expect(plan.rows.map((r) => r.problem)).toEqual([null, 'BARCODE_TAKEN', null])
  })

  it('with the switch on, refuses a new item with a code the shop already has', async () => {
    await unique(true)
    await setBarcodes(fx.db, ctx(), large, [{ barcode: '777' }])
    // 777 on two names in the file is two new items, and the shop's Glue 100ml already has it.
    const plan = await planImport(fx.db, file('Other glue,777,50', 'Another glue,777,50'))
    expect(plan.rows.map((r) => r.problem)).toEqual(['BARCODE_TAKEN', 'BARCODE_TAKEN'])
  })

  it('with the switch on, still reads a code one item has, under a new name, as that item renamed', async () => {
    await unique(true)
    const plan = await planImport(fx.db, file('Glue 200ml,8901234567890,40'))
    expect(plan.rows).toMatchObject([{ problem: null, action: 'update', productId: small }])
  })

  it('with the switch on, still updates an item by its own code', async () => {
    await unique(true)
    const plan = await planImport(fx.db, file('Glue 50ml,8901234567890,45'))
    expect(plan.rows).toMatchObject([{ problem: null, action: 'update', productId: small }])
  })
})
