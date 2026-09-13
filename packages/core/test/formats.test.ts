import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listFormats, loadFormat, getDefaultFormat, saveFormat } from '../src/services/formats.js'
import { freshDb, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => {
  fx = await freshDb()
})

afterEach(async () => { await fx.db.close() })

describe('document formats', () => {
  it('lists the two seeded defaults', async () => {
    const all = await listFormats(fx.db)
    expect(all).toHaveLength(2)
    expect(all.map((f) => f.id)).toEqual(['thermal_default', 'a4_default'])
  })

  it('filters by paper size', async () => {
    const thermal = await listFormats(fx.db, 'thermal_58')
    const a4 = await listFormats(fx.db, 'a4')

    expect(thermal).toHaveLength(1)
    expect(thermal[0]!.paper).toBe('thermal_58')
    expect(a4).toHaveLength(1)
    expect(a4[0]!.paper).toBe('a4')
  })

  it('loads one format by id', async () => {
    const fmt = await loadFormat(fx.db, 'thermal_default')

    expect(fmt).not.toBeNull()
    expect(fmt!.name).toBe('Standard Receipt')
    expect(fmt!.blocks.length).toBeGreaterThan(0)
  })

  it('gets the default format for a paper and document kind', async () => {
    const fmt = await getDefaultFormat(fx.db, 'a4', 'bill')

    expect(fmt).not.toBeNull()
    expect(fmt!.paper).toBe('a4')
    expect(fmt!.kinds).toContain('bill')
  })

  it('saves a new custom format', async () => {
    const custom = {
      id: 'custom_format',
      name: 'Minimal Receipt',
      paper: 'thermal_58' as const,
      kinds: ['bill'],
      blocks: [
        { kind: 'shop' as const, on: true },
        { kind: 'items' as const, on: true },
        { kind: 'totals' as const, on: true },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await saveFormat(fx.db, custom)

    const loaded = await loadFormat(fx.db, 'custom_format')
    expect(loaded).not.toBeNull()
    expect(loaded!.name).toBe('Minimal Receipt')
    expect(loaded!.blocks).toHaveLength(3)
  })

  it('parses block options from JSON', async () => {
    const fmt = await loadFormat(fx.db, 'thermal_default')

    const titleBlock = fmt!.blocks.find((b) => b.kind === 'title')
    expect(titleBlock).toBeDefined()
    expect(titleBlock!.opts).toEqual({ label: 'BILL' })
  })

  it('parses kinds as an array', async () => {
    const fmt = await loadFormat(fx.db, 'a4_default')

    expect(Array.isArray(fmt!.kinds)).toBe(true)
    expect(fmt!.kinds).toContain('bill')
  })
})
