import { describe, it, expect } from 'vitest'
import {
  buildReceipt, visibleLines, previewLines, savingsOf, rasterize, rasterCommand, readRaster, toBytes, logoDots,
  type ReceiptDoc,
} from '../src/domain/receipt.js'
import { STANDARD_RECEIPT, checkFormat, withEveryBlock, type Block, type DocFormat } from '../src/domain/docFormat.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'

/**
 * What a shop can switch on the roll (070): the MRP line under each item, the
 * total saved, the change given, and the logo printed as dots.
 */

const doc: ReceiptDoc = {
  shop: { name: 'TRT Stationery', address: 'Perambalur 621212', phone: '9047191778' },
  docNo: 'INV/26-27/00031',
  postingDate: '2026-10-08',
  items: [
    // MRP 12, sold at 10: the per-line saving is 2 x 12 = 24.
    { name: 'Glue stick', qty: fromUnits(12), saleUnit: 'piece', rate: rupees(10), lineTotal: rupees(120), mrp: rupees(12) },
    // No MRP: nothing to save against.
    { name: 'Loose clips', qty: fromUnits(1), saleUnit: 'piece', rate: rupees(30), lineTotal: rupees(30) },
  ],
  subtotal: rupees(150),
  discount: rupees(0),
  taxableTotal: rupees(150),
  cgst: 0 as Money,
  sgst: 0 as Money,
  igst: 0 as Money,
  grandTotal: rupees(150),
  payments: [{ method: 'cash', amount: rupees(150), tendered: rupees(200) }],
}

function withOpts(kind: Block['kind'], change: Partial<Block>): DocFormat {
  return { ...STANDARD_RECEIPT, blocks: STANDARD_RECEIPT.blocks.map((b) => (b.kind === kind ? { ...b, ...change } : b)) }
}

const lines = (roll: string) => visibleLines(roll).map((l) => l.trim())

describe('the MRP line under an item', () => {
  it('prints by default, MRP on the left and the saving on the right', () => {
    const mrp = visibleLines(buildReceipt(doc)).find((l) => l.includes('MRP'))
    expect(mrp).toBe(`   MRP 12.00${' '.repeat(42 - 3 - 'MRP 12.00'.length - 'Save 24.00'.length)}Save 24.00`)
  })

  it('can be switched off on the items block', () => {
    const roll = buildReceipt(doc, withOpts('items', { opts: { mrpSaving: false } }))
    expect(lines(roll).some((l) => l.startsWith('MRP'))).toBe(false)
    expect(lines(roll).some((l) => l.startsWith('Glue stick') || l.endsWith('Glue stick'))).toBe(true)
  })
})

describe('the total saved', () => {
  it('is the MRP less what the lines came to, discounts included', () => {
    expect(savingsOf(doc)).toBe(rupees(24))
    const discounted = { ...doc, items: [{ ...doc.items[0]!, lineTotal: rupees(110) }] }
    expect(savingsOf(discounted)).toBe(rupees(34))
  })

  it('prints one line under the total, and can be worded by the shop', () => {
    expect(lines(buildReceipt(doc))).toContain('You saved Rs.24.00')
    const worded = buildReceipt(doc, withOpts('savings', { opts: { label: 'Total savings' } }))
    expect(lines(worded)).toContain('Total savings Rs.24.00')
  })

  it('can be switched off', () => {
    expect(lines(buildReceipt(doc, withOpts('savings', { on: false }))).join('\n')).not.toMatch(/saved/)
  })

  it('prints nothing on a bill that saved nothing', () => {
    const plain = { ...doc, items: [doc.items[1]!] }
    expect(lines(buildReceipt(plain)).join('\n')).not.toMatch(/saved/)
  })

  it('reaches a format saved before the block existed, switched on', () => {
    const old = { ...STANDARD_RECEIPT, blocks: STANDARD_RECEIPT.blocks.filter((b) => b.kind !== 'savings') }
    const filled = withEveryBlock(old)
    const at = filled.blocks.findIndex((b) => b.kind === 'savings')
    expect(filled.blocks[at - 1]?.kind).toBe('totals')
    expect(filled.blocks[at]?.on).toBe(true)
  })
})

describe('the change given', () => {
  it('prints what was handed over and what went back', () => {
    const text = lines(buildReceipt(doc))
    expect(text.some((l) => /^Cash received\s+200\.00$/.test(l))).toBe(true)
    expect(text.some((l) => /^Change\s+50\.00$/.test(l))).toBe(true)
  })

  it('says nothing when the counter did not ask, or the money was exact', () => {
    for (const payments of [[{ method: 'cash', amount: rupees(150) }], [{ method: 'cash', amount: rupees(150), tendered: rupees(150) }]]) {
      expect(lines(buildReceipt({ ...doc, payments })).join('\n')).not.toMatch(/Change/)
    }
  })
})

describe('the logo on the roll', () => {
  // A 10 x 2 picture: the left half black, the right half white but transparent in the second row.
  const rgba: number[] = []
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 10; x++) rgba.push(...(x < 5 ? [0, 0, 0, 255] : [0, 0, 0, y === 0 ? 255 : 0]))
  }
  const raster = rasterize(rgba, 10, 2)

  it('reduces pixels to dots, padding the width to whole bytes and treating transparent as paper', () => {
    expect(raster.width).toBe(16)
    expect([...raster.bits]).toEqual([0xFF, 0xC0, 0xF8, 0x00])
  })

  it('is no longer refused on a roll format', () => {
    expect(checkFormat(withOpts('logo', { on: true }))).toEqual([])
  })

  it('prints as GS v 0 above the shop name, and the bytes survive the trip to the printer', () => {
    const roll = buildReceipt({ ...doc, logoRaster: raster }, withOpts('logo', { on: true }))
    const at = roll.indexOf('\x1Dv0')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(roll.indexOf('TRT Stationery'))
    expect(readRaster(roll, at)?.raster).toEqual(raster)

    // A byte of 0xFF goes as one byte, not as UTF-8's two.
    const bytes = toBytes(roll)
    expect(bytes.length).toBe(roll.length)
    expect(bytes).toContain(0xFF)
  })

  it('bytes that look like replacement patterns are carried as they are', () => {
    const dollars = { width: 8, height: 2, bits: Uint8Array.from([0x24, 0x26]) } // "$&"
    const roll = buildReceipt({ ...doc, logoRaster: dollars }, withOpts('logo', { on: true }))
    expect(roll).toContain(rasterCommand(dollars))
  })

  it('shows in the preview as a picture, with none of its bytes read as text', () => {
    const roll = buildReceipt({ ...doc, logoRaster: raster }, withOpts('logo', { on: true }))
    const preview = previewLines(roll)
    expect(preview.filter((l) => l.raster)).toHaveLength(1)
    expect(preview.find((l) => l.raster)?.raster).toEqual(raster)
    expect(visibleLines(roll)).toEqual(visibleLines(buildReceipt(doc, withOpts('logo', { on: true }))))
  })

  it('prints nothing when there is no logo to print', () => {
    const roll = buildReceipt(doc, withOpts('logo', { on: true }))
    expect(roll).not.toContain('\x1Dv0')
    expect(roll).not.toContain('LOGO')
  })

  it('is as tall as the block asks, within bounds', () => {
    expect(logoDots(undefined)).toBe(128)
    expect(logoDots(10)).toBe(80)
    expect(logoDots(500)).toBe(320)
  })
})
