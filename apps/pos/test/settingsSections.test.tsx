import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

/**
 * Settings, as sections.
 *
 * What is asserted is what only the screen decides: which sections a role is
 * shown, that the one asked for is the one opened, and that the three
 * one-of-several questions on Tax & billing are three questions to the browser
 * and not one -- they shared a radio name, and arrowing off the last GST option
 * changed the stock policy.
 */

let visible: string[] = ['settings', 'formats', 'registers', 'users']

vi.mock('@shopos/core', async (real) => {
  const actual = await real<Record<string, unknown> & { Permissions: object }>()
  return { ...actual, Permissions: { ...actual.Permissions, visiblePages: () => visible } }
})

const core = {
  db: {},
  features: { multiBarcode: false, tieredPricing: true, uniquePhone: false },
  setFeatureFlag: vi.fn(),
  stockPolicy: 'warn', setStockPolicyTo: vi.fn(),
  rounding: 'none', setRoundingTo: vi.fn(),
  taxScheme: 'regular', taxSchemeAsked: true, setTaxSchemeTo: vi.fn(),
}
const user = { id: 'u1', username: 'owner', roleName: 'Admin', permissions: {} }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core, useUser: () => user }))

vi.mock('../src/pages/Formats', () => ({ Formats: () => <div>the format editor</div> }))
vi.mock('../src/ui/SyncCard', () => ({ SyncCard: () => <div>sync</div> }))
vi.mock('../src/ui/LicenceCard', () => ({ LicenceCard: () => <div>licence</div> }))
vi.mock('../src/pages/settings/ShopSection', () => ({ ShopSection: () => <div>shop details form</div> }))
vi.mock('../src/pages/settings/BackupsSection', () => ({ BackupsSection: () => <div>backups</div> }))
vi.mock('../src/pages/settings/HelpSection', () => ({ HelpSection: () => <div>help</div> }))
vi.mock('../src/pages/settings/DeviceSections', () => ({
  PrinterSection: () => <div>printer</div>, AppearanceSection: () => <div>appearance</div>,
}))

const { default: Settings } = await import('../src/pages/Settings')

afterEach(() => { cleanup(); visible = ['settings', 'formats', 'registers', 'users'] })

describe('the sections a role is shown', () => {
  it('lists Bill format for a role that may edit formats, and opens it when asked to', () => {
    render(<Settings initial="format" />)
    expect(screen.getByText('the format editor')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bill format' }).getAttribute('aria-current')).toBe('true')
  })

  it('leaves Bill format and Counters & staff out for a role that has neither', () => {
    visible = ['settings']
    render(<Settings initial="format" />)
    expect(screen.queryByRole('button', { name: 'Bill format' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Counters & staff' })).toBeNull()
    // Asked for a section it cannot see, it opens on the first one instead.
    expect(screen.getByText('shop details form')).toBeTruthy()
  })
})

describe('Tax & billing', () => {
  it('asks its three questions as three separate radio groups', () => {
    render(<Settings initial="tax" />)
    const groups = screen.getAllByRole('radiogroup')
    expect(groups).toHaveLength(3)
    const names = groups.map((g) => (g.querySelector('input[type="radio"]') as HTMLInputElement).name)
    expect(new Set(names).size).toBe(3)
  })

  it('changes only the setting whose option was chosen', () => {
    render(<Settings initial="tax" />)
    fireEvent.click(screen.getByLabelText(/Nearest rupee/))
    expect(core.setRoundingTo).toHaveBeenCalledWith('nearest')
    expect(core.setStockPolicyTo).not.toHaveBeenCalled()
  })
})
