import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FEATURES_OFF, type BarcodeOnSeveral, type Features } from '@shopos/core'

/**
 * The One item per barcode switch in Settings, Features: it flips the shop's
 * setting, and while on it lists the codes still on more than one item.
 */

const shared: { now: BarcodeOnSeveral[] } = { now: [] }
vi.mock('@shopos/core', async (load) => ({
  ...(await load<typeof import('@shopos/core')>()),
  sharedBarcodes: async () => shared.now,
}))

const core: { db: object; features: Features; setFeatureFlag: ReturnType<typeof vi.fn> } = {
  db: {}, features: FEATURES_OFF, setFeatureFlag: vi.fn(async () => {}),
}
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))
const { FeaturesSection } = await import('../src/pages/settings/FeaturesSection')

afterEach(() => { cleanup(); shared.now = []; core.setFeatureFlag.mockClear() })

const glue: BarcodeOnSeveral = {
  barcode: '8901234567890',
  items: [{ productId: 'a', productName: 'Glue 50ml' }, { productId: 'b', productName: 'Glue 100ml' }],
}

describe('one item per barcode, in Settings', () => {
  it('turns the shop’s setting on', () => {
    core.features = FEATURES_OFF
    render(<FeaturesSection />)
    fireEvent.click(screen.getByLabelText(/One item per barcode/))
    expect(core.setFeatureFlag).toHaveBeenCalledWith('uniqueBarcode', true)
  })

  it('lists the codes still on more than one item while it is on', async () => {
    core.features = { ...FEATURES_OFF, uniqueBarcode: true }
    shared.now = [glue]
    render(<FeaturesSection />)
    expect(await screen.findByText(/One code is still on more than one item/)).toBeTruthy()
    expect(screen.getByText('8901234567890: Glue 50ml, Glue 100ml')).toBeTruthy()
  })

  it('lists nothing while it is off, whatever is shared', async () => {
    core.features = FEATURES_OFF
    shared.now = [glue]
    render(<FeaturesSection />)
    await Promise.resolve()
    expect(screen.queryByText(/still on more than one item/)).toBeNull()
  })
})
