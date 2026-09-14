import { describe, it, expect } from 'vitest'
import {
  buildReceipt, visibleLines, previewLines, smallColumns, type ReceiptDoc,
} from '../src/domain/receipt.js'
import { STANDARD_RECEIPT, rollColumns, type Block, type DocFormat } from '../src/domain/docFormat.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'

/**
 * What the format actually changes on the paper.
 *
 * The first test here is the one that matters most: a shop that never opens the
 * designer must get the receipt it got yesterday, to the byte.
 */

const doc: ReceiptDoc = {
  shop: {
    name: 'TRT Stationery',
    address: 'Perambalur 621212, Tamil Nadu',
    phone: '9047191778',
    gstin: '33ALNPJ1906G1ZC',
  },
  docNo: 'INV/MR/26-27/00023',
  postingDate: '2026-09-12',
  cashier: 'admin',
  customerName: 'Sri Vidya School',
  items: [
    { name: 'A4 Copier Paper 500 sheets', qty: fromUnits(2), saleUnit: 'ream', rate: rupees(340), lineTotal: rupees(680) },
    { name: 'Ball Pen Blue', qty: fromUnits(12), saleUnit: 'piece', rate: rupees(10), lineTotal: rupees(120) },
  ],
  subtotal: rupees(800),
  discount: rupees(0),
  taxableTotal: rupees(677.97),
  cgst: rupees(61.01),
  sgst: rupees(61.01),
  igst: 0 as Money,
  grandTotal: rupees(800),
  payments: [{ method: 'cash', amount: rupees(800) }],
  pointsEarned: 8,
  pointsBalance: 120,
}

function withBlocks(changes: Partial<Record<Block['kind'], boolean>>): DocFormat {
  return {
    ...STANDARD_RECEIPT,
    blocks: STANDARD_RECEIPT.blocks.map((b) =>
      b.kind in changes ? { ...b, on: changes[b.kind]! } : b,
    ),
  }
}

/** How many lines carry this label, so "printed twice" is a number not a guess. */
function countLines(receipt: string, startsWith: string): number {
  return visibleLines(receipt).filter((l) => l.startsWith(startsWith)).length
}

/** Every printed line inside the columns its own face allows: the small print
    is set in font B, which fits a third more than the wide face. */
function expectFitsPaper(receipt: string, columns: number) {
  for (const line of previewLines(receipt)) {
    const limit = line.small ? smallColumns(columns) : columns
    expect(line.text.length, `too wide for ${limit} columns: "${line.text}"`).toBeLessThanOrEqual(limit)
  }
}

describe('a shop that has never opened the designer', () => {
  it('gets exactly the receipt it got before formats existed', () => {
    // The 13 tests in receipt.test.ts pin what that receipt is; this pins that
    // asking for the shipped format explicitly changes nothing about it.
    expect(buildReceipt(doc, STANDARD_RECEIPT)).toBe(buildReceipt(doc))
  })

  it('is never charged tax twice on the same paper', () => {
    const receipt = buildReceipt(doc)
    expect(countLines(receipt, 'CGST')).toBe(1)
    expect(countLines(receipt, 'SGST')).toBe(1)
  })

  it('sees the customer named once, not once more in a block of their own', () => {
    expect(countLines(buildReceipt(doc), 'Sri Vidya School')).toBe(1)
  })
})

describe('switching a block off', () => {
  it('takes the footer note off the paper', () => {
    expect(buildReceipt(doc).includes('Goods once sold')).toBe(true)
    expect(buildReceipt(doc, withBlocks({ terms: false })).includes('Goods once sold')).toBe(false)
  })

  it('takes the points off without touching the totals', () => {
    const without = buildReceipt(doc, withBlocks({ loyalty: false }))
    expect(without.includes('Points earned')).toBe(false)
    expect(countLines(without, 'TOTAL')).toBe(1)
  })

  it('leaves the shop unnamed when the shop block is off, and prints the rest', () => {
    const without = buildReceipt(doc, withBlocks({ shop: false }))
    expect(without.includes('TRT Stationery')).toBe(false)
    expect(without.includes('INV/MR/26-27/00023')).toBe(true)
  })
})

describe('switching a block on', () => {
  it('adds the title the shop typed', () => {
    const titled = {
      ...STANDARD_RECEIPT,
      blocks: STANDARD_RECEIPT.blocks.map((b) =>
        b.kind === 'title' ? { ...b, on: true, opts: { label: 'TAX INVOICE' } } : b,
      ),
    }
    expect(buildReceipt(doc, titled).includes('TAX INVOICE')).toBe(true)
  })

  it('prints a line of the shop own words, with the tokens filled in', () => {
    const withText: DocFormat = {
      ...STANDARD_RECEIPT,
      blocks: [
        ...STANDARD_RECEIPT.blocks,
        { kind: 'text', on: true, opts: { body: 'Queries: {{shop.phone}}' } },
      ],
    }
    expect(buildReceipt(doc, withText).includes('Queries: 9047191778')).toBe(true)
  })

  it('prints nothing for a text block the shop left empty', () => {
    const empty: DocFormat = {
      ...STANDARD_RECEIPT,
      blocks: [...STANDARD_RECEIPT.blocks, { kind: 'text', on: true, opts: { body: '   ' } }],
    }
    expect(buildReceipt(doc, empty)).toBe(buildReceipt(doc))
  })

  it('does not repeat the tax lines when the tax summary is used instead of them', () => {
    const summarised = withBlocks({ tax_summary: true, totals: false })
    expect(countLines(buildReceipt(doc, summarised), 'CGST')).toBe(1)
  })
})

describe('the small print', () => {
  it('is wrapped in the condensed face’s own columns, not the wide face’s', () => {
    const long = {
      ...doc,
      footer: 'Thank you. Goods once sold are not returnable without this bill. Please keep it safe.',
    }
    const lines = previewLines(buildReceipt(long)).filter((l) => l.small && l.text.trim() !== '')

    // Font B fits 56 columns on an 80mm roll. Measured against font A's 42 the
    // sentence broke a third of the way early, and the ragged edge that left
    // reads as a centring fault rather than as the wrong ruler.
    expect(lines.some((l) => l.text.length > 42)).toBe(true)
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(smallColumns(42))
  })

  it('is centred, every line of it', () => {
    for (const line of previewLines(buildReceipt(doc)).filter((l) => l.small && l.text.trim() !== '')) {
      expect(line.align).toBe('centre')
    }
  })
})

describe('the amount in words on the roll', () => {
  const spelled = withBlocks({ amount_in_words: true })

  it('spells the total out', () => {
    expect(buildReceipt(doc, spelled)).toContain('Rupees Eight Hundred Only')
  })

  it('wraps inside the narrow roll rather than running off it', () => {
    const narrow: DocFormat = { ...spelled, paper: 'thermal_58' }
    expectFitsPaper(buildReceipt(doc, narrow), rollColumns('thermal_58'))
  })
})

describe('the order the shop arranged them in', () => {
  it('puts the blocks on the paper in that order', () => {
    const reversed: DocFormat = {
      ...STANDARD_RECEIPT,
      blocks: STANDARD_RECEIPT.blocks.slice().reverse(),
    }
    const lines = visibleLines(buildReceipt(doc, reversed)).filter((l) => l.trim())

    const footer = lines.findIndex((l) => l.includes('Goods once sold'))
    const shop = lines.findIndex((l) => l.includes('TRT Stationery'))
    expect(footer).toBeLessThan(shop)
  })
})

describe('the narrower roll', () => {
  const narrow: DocFormat = { ...STANDARD_RECEIPT, paper: 'thermal_58' }

  it('keeps every line inside 32 columns, where 42 would wrap and break the alignment', () => {
    expectFitsPaper(buildReceipt(doc, narrow), rollColumns('thermal_58'))
  })

  it('draws its rules to the narrower width, not the wider one', () => {
    const rules = visibleLines(buildReceipt(doc, narrow)).filter((l) => /^-+$/.test(l))
    expect(rules.length).toBeGreaterThan(0)
    for (const line of rules) expect(line.length).toBe(rollColumns('thermal_58'))
  })

  it('still carries everything a bill must carry', () => {
    const receipt = buildReceipt(doc, narrow)
    expect(receipt.includes('INV/MR/26-27/00023')).toBe(true)
    expect(receipt.includes('33ALNPJ1906G1ZC')).toBe(true)
    expect(receipt.includes('CGST')).toBe(true)
  })
})

describe('the printer, whatever the format', () => {
  it('opens with a reset and ends with a cut even when most blocks are off', () => {
    const bare = {
      ...STANDARD_RECEIPT,
      blocks: STANDARD_RECEIPT.blocks.map((b) => ({ ...b, on: b.kind === 'items' })),
    }
    const receipt = buildReceipt(doc, bare)
    expect(receipt.startsWith('\x1B@')).toBe(true)
    expect(receipt.endsWith('\x1DV\x01')).toBe(true)
  })
})
