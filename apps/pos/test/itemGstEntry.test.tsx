import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { migrate, bootstrap, newId, loadFeatures, type SqlDriver } from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'

/**
 * Adding an item: the selling rate and the cost price typed before GST or
 * with it, each kept as it is stored, and the HSN and GST filled from the
 * shop's other items -- a new brand of scissors is the old scissors' code.
 */

let db: SqlDriver
let core: Record<string, unknown>
const settings = new Map<string, string>()

vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core, useDb: () => core['db'] }))
vi.mock('../src/core/device', () => ({
  deviceSetting: (key: string) => settings.get(key) ?? null,
  setDeviceSetting: async (key: string, value: string | null) => {
    if (value === null) settings.delete(key); else settings.set(key, value)
    return true
  },
}))

const { ProductForm } = await import('../src/pages/inventory/ProductForm')
const { BLANK } = await import('../src/pages/inventory/draft')
type Draft = typeof BLANK
const { useParentSearch } = await import('../src/pages/inventory/useParentSearch')
const { stored } = await import('../src/pages/inventory/prices')

beforeEach(async () => {
  settings.clear()
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  await bootstrap(db, { shopName: 'TRT GENERAL STORE' })
  const now = new Date().toISOString()
  for (const [name, hsn, bp] of [['Kangaro Scissors', '8213', 1800], ['Camlin Scissor', '8213', 1800], ['Classmate Notebook', '4820', 1200]] as const) {
    await db.execute(
      `INSERT INTO products (id, name, hsn_code, tax_rate_bp, base_rate, created_at, updated_at) VALUES (?, ?, ?, ?, 5000, ?, ?)`,
      [newId(), name, hsn, bp, now, now])
  }
  core = { db, features: await loadFeatures(db) }
})
afterEach(async () => { cleanup(); await db.close() })

let current: Draft = BLANK
function Form({ start }: { start: Draft }) {
  const [draft, setDraft] = useState(start)
  current = draft
  const parent = useParentSearch(db, draft, setDraft as never)
  return (
    <ProductForm draft={draft} setDraft={setDraft} categories={[]} newCategory="" setNewCategory={vi.fn()}
      onAddCategory={vi.fn()} parentName={undefined} parent={parent} />
  )
}

const box = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.change(box(id), { target: { value } })
const switchOf = (label: string, side: 'Excl. GST' | 'Incl. GST') =>
  screen.getByRole('group', { name: label }).querySelector<HTMLButtonElement>(
    `button:nth-child(${side === 'Excl. GST' ? 1 : 2})`)!

describe('the selling rate and cost price, either side of GST', () => {
  it('takes a selling rate before GST and keeps it with GST', async () => {
    render(<Form start={{ ...BLANK, taxPercent: '18' }} />)
    fireEvent.click(switchOf('Selling rate is', 'Excl. GST'))
    type('p-rate', '100')
    expect(screen.getByText(/₹118\.00 with GST/)).toBeTruthy()
    expect(stored(current, current.baseRate, current.rateSide, 'with')).toBe(11800)
    // Flipped back, the box shows what will be kept.
    fireEvent.click(switchOf('Selling rate is', 'Incl. GST'))
    expect(box('p-rate').value).toBe('118.00')
  })

  it('takes a cost with GST and keeps it before GST', async () => {
    render(<Form start={{ ...BLANK, taxPercent: '18' }} />)
    fireEvent.click(switchOf('Cost price is', 'Incl. GST'))
    type('p-cost', '59')
    expect(stored(current, current.costPrice, current.costSide, 'before')).toBe(5000)
    expect(screen.getByText(/₹50\.00 before GST/)).toBeTruthy()
  })

  it('writes back an untouched item exactly, whichever way the switches are', async () => {
    settings.set('rate_entry_gst', 'before')
    settings.set('cost_entry_gst', 'with')
    render(<Form start={{ ...BLANK, id: 'x', taxPercent: '18', baseRate: '100.00', costPrice: '62.00' }} />)
    expect(box('p-rate').value).toBe('84.74')
    expect(stored(current, current.baseRate, current.rateSide, 'with')).toBe(10000)
    expect(stored(current, current.costPrice, current.costSide, 'before')).toBe(6200)
  })

  it('remembers each switch on this machine', async () => {
    render(<Form start={BLANK} />)
    fireEvent.click(switchOf('Selling rate is', 'Excl. GST'))
    fireEvent.click(switchOf('Cost price is', 'Incl. GST'))
    expect(settings.get('rate_entry_gst')).toBe('before')
    // The same switch Stock In and purchase orders use.
    expect(settings.get('cost_entry_gst')).toBe('with')
  })
})

describe('HSN and GST from the shop items', () => {
  it('offers the scissors code for a new brand of scissors, and fills both boxes', async () => {
    render(<Form start={BLANK} />)
    type('p-name', 'Faber Scissors 8 inch')
    type('p-brand', 'Faber')
    fireEvent.click(await screen.findByRole('button', { name: /HSN 8213 · 18%/ }))
    expect(box('p-hsn').value).toBe('8213')
    expect(box('p-gst').value).toBe('18')
  })

  it('brings the rate with a code typed in, and says where from', async () => {
    render(<Form start={BLANK} />)
    type('p-hsn', '8213')
    await waitFor(() => expect(box('p-gst').value).toBe('18'))
    expect(screen.getByText(/GST 18%, as on your 2 other items with 8213/)).toBeTruthy()
  })

  it('offers nothing once the item has a code', async () => {
    render(<Form start={{ ...BLANK, hsnCode: '4820' }} />)
    type('p-name', 'Faber Scissors')
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByRole('button', { name: /HSN 8213/ })).toBeNull()
  })
})
