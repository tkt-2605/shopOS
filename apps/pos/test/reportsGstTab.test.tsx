import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { migrate, bootstrap, type SqlDriver, type TaxScheme } from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'

/**
 * The GST tab is offered only to a shop that collects GST.
 *
 * `chargesTax()` is tested in core; this is `Reports.tsx` reading it. A
 * composition dealer or an unregistered shop collects none, so the tab would
 * be a page of zeroes and its export a file of them. And a shop that switches
 * scheme while standing on the tab must be moved off it, not left on a tab
 * that no longer exists.
 */

const core: { db: SqlDriver | null; taxScheme: TaxScheme } = { db: null, taxScheme: 'regular' }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))
vi.mock('../src/core/syncLoop', () => ({ onSyncRound: () => () => {} }))
vi.mock('../src/ui/Completeness', () => ({ Completeness: () => null }))
vi.mock('../src/core/exportFile', () => ({ saveFile: vi.fn() }))
vi.mock('../src/core/pdf', () => ({ reportPdf: vi.fn() }))

const { default: Reports } = await import('../src/pages/Reports')

beforeEach(async () => {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  await bootstrap(db, { shopName: 'Test Shop' })
  core.db = db
  core.taxScheme = 'regular'
})
afterEach(async () => {
  cleanup()
  await core.db?.close()
})

const tab = (name: string) => screen.queryByRole('button', { name })

describe('the GST tab', () => {
  it('is there for a shop that collects GST', async () => {
    render(<Reports />)
    await waitFor(() => expect(tab('By day')).not.toBeNull())
    expect(tab('GST')).not.toBeNull()
  })

  it.each(['composition', 'unregistered'] as const)('is not there for a %s shop, which is told why', async (scheme) => {
    core.taxScheme = scheme
    render(<Reports />)
    await waitFor(() => expect(tab('By day')).not.toBeNull())
    expect(tab('GST')).toBeNull()
    expect(screen.getByText(/there is no GST report to run/)).toBeTruthy()
  })

  it('moves a shop off it when the shop stops collecting GST while it is open', async () => {
    const { rerender } = render(<Reports />)
    await waitFor(() => expect(tab('GST')).not.toBeNull())
    fireEvent.click(tab('GST')!)
    expect(tab('GST')!.getAttribute('aria-pressed')).toBe('true')

    core.taxScheme = 'composition'
    rerender(<Reports />)

    await waitFor(() => expect(tab('By day')!.getAttribute('aria-pressed')).toBe('true'))
    expect(tab('GST')).toBeNull()
  })
})
