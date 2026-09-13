import { describe, it, expect } from 'vitest'
import {
  STANDARD_RECEIPT, PAPER_COLUMNS, NOT_YET,
  checkFormat, fillTokens, moveBlock, withEveryBlock,
  type Block, type DocFormat,
} from '../src/domain/docFormat.js'

/**
 * The rules a format has to obey, with no printer and no database in sight.
 */

function format(over: Partial<DocFormat> = {}): DocFormat {
  return { ...STANDARD_RECEIPT, ...over }
}

const ITEMS: Block = { kind: 'items', on: true }

describe('what a format is allowed to be', () => {
  it('accepts the format the product ships with', () => {
    expect(checkFormat(STANDARD_RECEIPT)).toEqual([])
  })

  it('refuses a format with no name, because a list of blank rows cannot be chosen from', () => {
    const problems = checkFormat(format({ name: '   ' }))
    expect(problems).toContainEqual({ code: 'NAME_REQUIRED' })
  })

  it('refuses a receipt with every block switched off', () => {
    const problems = checkFormat(format({ blocks: STANDARD_RECEIPT.blocks.map((b) => ({ ...b, on: false })) }))
    expect(problems).toContainEqual({ code: 'NOTHING_ON' })
  })

  it('refuses a receipt with no items on it, which is a total on a slip of paper', () => {
    const blocks = STANDARD_RECEIPT.blocks.map((b) => (b.kind === 'items' ? { ...b, on: false } : b))
    expect(checkFormat(format({ blocks }))).toContainEqual({ code: 'NO_ITEMS_BLOCK' })
  })

  it('refuses a block that has no renderer behind it yet', () => {
    const blocks: Block[] = [ITEMS, { kind: 'logo', on: true }]
    expect(checkFormat(format({ blocks }))).toContainEqual({ code: 'NOT_IMPLEMENTED', kind: 'logo' })
  })

  it('says nothing about an unfinished block that is switched off', () => {
    const blocks: Block[] = [ITEMS, { kind: 'logo', on: false }]
    expect(checkFormat(format({ blocks }))).toEqual([])
  })

  it('names every unfinished block at once rather than one per save', () => {
    const blocks: Block[] = [ITEMS, { kind: 'logo', on: true }, { kind: 'amount_in_words', on: true }]
    const problems = checkFormat(format({ blocks }))
    expect(problems).toHaveLength(Object.keys(NOT_YET).length)
  })
})

describe('the shipped format', () => {
  it('prints on the 80mm roll the product has always assumed', () => {
    expect(STANDARD_RECEIPT.paper).toBe('thermal_80')
    expect(PAPER_COLUMNS[STANDARD_RECEIPT.paper]).toBe(42)
  })

  it('leaves off the blocks that would print a second copy of something', () => {
    const off = (kind: string) => STANDARD_RECEIPT.blocks.find((b) => b.kind === kind)?.on
    // `totals` already carries the tax lines; `meta` already carries the name.
    expect(off('tax_summary')).toBe(false)
    expect(off('party')).toBe(false)
  })

  it('leaves off every block that has no renderer, so no switch is a lie', () => {
    for (const block of STANDARD_RECEIPT.blocks) {
      if (NOT_YET[block.kind]) expect(block.on, `${block.kind} is on but unfinished`).toBe(false)
    }
  })
})

describe('a format saved by an older build', () => {
  it('keeps the blocks it knew about', () => {
    const old = format({ blocks: [{ kind: 'items', on: false }] })
    const filled = withEveryBlock(old)
    expect(filled.blocks.find((b) => b.kind === 'items')!.on).toBe(false)
  })

  it('takes the standard opinion on a block added since, rather than dropping it', () => {
    const old = format({ blocks: [ITEMS] })
    const filled = withEveryBlock(old)

    expect(filled.blocks.find((b) => b.kind === 'terms')).toEqual({ kind: 'terms', on: true })
    expect(filled.blocks).toHaveLength(STANDARD_RECEIPT.blocks.length)
  })

  it('puts the block back where the standard has it, not at the bottom of the receipt', () => {
    // Appending would put a logo below the footer note.
    const old = format({ blocks: [{ kind: 'shop', on: true }, ITEMS] })
    const kinds = withEveryBlock(old).blocks.map((b) => b.kind)

    expect(kinds.indexOf('logo')).toBeLessThan(kinds.indexOf('shop'))
    expect(kinds.indexOf('meta')).toBeLessThan(kinds.indexOf('items'))
    expect(kinds.indexOf('terms')).toBeGreaterThan(kinds.indexOf('items'))
  })

  it('leaves the shop own arrangement of its blocks alone', () => {
    const old = format({ blocks: [ITEMS, { kind: 'shop', on: true }] })
    const kinds = withEveryBlock(old).blocks.map((b) => b.kind)

    expect(kinds.indexOf('items')).toBeLessThan(kinds.indexOf('shop'))
  })
})

describe('rearranging blocks', () => {
  const blocks: Block[] = [
    { kind: 'shop', on: true }, { kind: 'meta', on: true }, { kind: 'items', on: true },
  ]

  it('moves a block to where it was dropped', () => {
    expect(moveBlock(blocks, 2, 0).map((b) => b.kind)).toEqual(['items', 'shop', 'meta'])
  })

  it('answers unchanged at the top rather than throwing', () => {
    expect(moveBlock(blocks, 0, -1)).toBe(blocks)
  })

  it('answers unchanged at the bottom rather than throwing', () => {
    expect(moveBlock(blocks, 2, 3)).toBe(blocks)
  })

  it('leaves the original alone, so a cancelled drag changes nothing', () => {
    moveBlock(blocks, 2, 0)
    expect(blocks.map((b) => b.kind)).toEqual(['shop', 'meta', 'items'])
  })
})

describe('tokens in a line the shop typed', () => {
  const facts = { 'shop.name': 'TRT Stationery', 'doc.no': 'INV/0023' }

  it('puts the fact where the token was', () => {
    expect(fillTokens('Issued by {{shop.name}}', facts)).toBe('Issued by TRT Stationery')
  })

  it('fills more than one token on a line', () => {
    expect(fillTokens('{{shop.name}} — {{doc.no}}', facts)).toBe('TRT Stationery — INV/0023')
  })

  it('ignores spacing inside the braces, which is the common typo', () => {
    expect(fillTokens('{{  shop.name  }}', facts)).toBe('TRT Stationery')
  })

  it('renders a misspelled token as nothing, never as the braces themselves', () => {
    // The shopkeeper typed it, never saw it, and the customer would have.
    expect(fillTokens('Issued by {{shop.nmae}}', facts)).toBe('Issued by ')
  })

  it('leaves a line with no tokens exactly as it was typed', () => {
    expect(fillTokens('Terms: payment within 30 days', facts)).toBe('Terms: payment within 30 days')
  })
})
