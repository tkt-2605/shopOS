import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { FEATURES_OFF, type Features } from '@shopos/core'

/**
 * The units on the item form (079): with "Box prices and MRP" off a box is
 * its pieces and nothing more is asked; on, each unit has its MRP and price,
 * and an empty price says what the box comes to as its pieces.
 */

let features: Features = FEATURES_OFF
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => ({ features }) }))

const { UnitRows } = await import('../src/pages/inventory/UnitRows')
const { BLANK } = await import('../src/pages/inventory/draft')

afterEach(() => { cleanup(); features = FEATURES_OFF })

const draft = {
  ...BLANK, id: 'pen', name: 'Pen',
  units: [{ saleUnit: 'box', baseUnits: '10', mrp: '90.00', rate: '', asPieces: '90.00' }],
}

describe('the units on the item form', () => {
  it('off, asks only what a unit holds, and says it is priced as its pieces', () => {
    render(<UnitRows draft={draft} setDraft={vi.fn()} />)
    expect(screen.queryByLabelText('MRP of a box')).toBeNull()
    expect(screen.queryByLabelText('Price of a box')).toBeNull()
    expect(screen.getByText(/priced as its piece: the selling rate times how many it holds/)).toBeTruthy()
  })

  it('on, gives each unit its MRP and price, and an empty price says what the box comes to', () => {
    features = { ...FEATURES_OFF, unitPrices: true }
    render(<UnitRows draft={draft} setDraft={vi.fn()} />)
    expect((screen.getByLabelText('MRP of a box') as HTMLInputElement).value).toBe('90.00')
    expect((screen.getByLabelText('Price of a box') as HTMLInputElement).placeholder).toBe('90.00 as piece')
  })
})
