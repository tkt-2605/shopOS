import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ProductListItem } from '@shopos/core'
import { VariantChoice, type VariantPick } from '../src/ui/VariantChoice'

/**
 * The variant box a scan of the XO pen's code opens: the keys a cashier uses
 * with a queue waiting. A number picks, Enter takes the highlighted variant --
 * the one picked last for this pen -- and a handful of mixed variants is a
 * count against each and one Enter.
 */

afterEach(cleanup)

const variant = (id: string, label: string, stock = 10): ProductListItem => ({
  id, code: null, name: `XO pen (${label})`, brand: null, barcode: '890', baseUnit: 'piece',
  baseRate: 1000, mrp: null, taxRateBp: 1800, cessRateBp: 0, hsnCode: null, isStockTracked: true, isActive: true,
  qtyOnHand: stock * 10_000, discountBlocked: false, loyaltyBlocked: false, returnBlocked: false, openPrice: false,
  costPrice: null, reorderLevel: null, reorderQty: null, categoryId: null, categoryName: null,
  parentProductId: 'pen', parentName: 'XO pen', variantLabel: label, versions: 0,
} as unknown as ProductListItem)

const items = [variant('b', 'Blue'), variant('k', 'Black'), variant('r', 'Red', 0)]

function open(quantities: boolean, familyId = 'pen') {
  const picked: VariantPick[][] = []
  render(<VariantChoice familyId={familyId} name="XO pen" items={items} quantities={quantities}
    onDone={(p) => picked.push(p)} onClose={vi.fn()} />)
  return { picked, box: screen.getByLabelText('Variants of XO pen') }
}
const names = (picks: VariantPick[]) => picks.map((p) => `${p.product.variantLabel} ${p.qty}`)

describe('the variant box', () => {
  it('asks which variant of the pen, with every variant listed and the price once', () => {
    open(true)
    expect(screen.getByText('XO pen — which one?')).toBeTruthy()
    expect(screen.getAllByRole('option').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Blue'), expect.stringContaining('Black'), expect.stringContaining('Red'),
    ])
    expect(screen.getByText('₹10.00 each')).toBeTruthy()
  })

  it('takes a variant by its number', () => {
    const { picked, box } = open(true, 'pen-a')
    fireEvent.keyDown(box, { key: '2' })
    expect(names(picked[0]!)).toEqual(['Black 1'])
  })

  it('opens on the variant picked last for that pen, so a run of one variant is scan and Enter', () => {
    const first = open(false, 'pen-b')
    fireEvent.keyDown(first.box, { key: '3' })
    cleanup()
    const again = open(false, 'pen-b')
    fireEvent.keyDown(again.box, { key: 'Enter' })
    expect(names(again.picked[0]!)).toEqual(['Red 1'])
  })

  it('adds a mixed handful with one Enter, each variant by the count typed against it', () => {
    const { picked } = open(true, 'pen-c')
    fireEvent.change(screen.getByLabelText('How many Blue'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('How many Red'), { target: { value: '2x' } })
    // A digit typed into a count is a count, not a variant's number.
    fireEvent.keyDown(screen.getByLabelText('How many Red'), { key: '1' })
    expect(picked).toEqual([])
    fireEvent.keyDown(screen.getByLabelText('How many Red'), { key: 'Enter' })
    expect(names(picked[0]!)).toEqual(['Blue 3', 'Red 2'])
  })

  it('has no counts where the screen takes one item at a time', () => {
    open(false, 'pen-d')
    expect(screen.queryByLabelText('How many Blue')).toBeNull()
  })
})
