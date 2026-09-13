import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listFormats, loadFormat, formatFor, saveFormat, deleteFormat, chooseFormat, chosenFormatId,
} from '../src/services/formats.js'
import { STANDARD_RECEIPT, rollColumns, type Block } from '../src/domain/docFormat.js'
import { buildReceipt, visibleLines, type ReceiptDoc } from '../src/domain/receipt.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Keeping a shop's layouts, and never letting a bad one reach the printer.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

const ITEMS: Block = { kind: 'items', on: true }

async function auditRows(entityId: string) {
  return fx.db.query<{ action: string; actor_id: string; diff: string | null }>(
    `SELECT action, actor_id, diff FROM audit_log WHERE entity = 'doc_format' AND entity_id = ?`,
    [entityId],
  )
}

describe('what a new shop starts with', () => {
  it('has the format the product has always printed, written down', async () => {
    // Not seeded as a blank slate: a shop must be able to see what it prints
    // today before it is asked to change any of it.
    const roll = await listFormats(fx.db, 'thermal_80')
    expect(roll).toHaveLength(1)
    expect(roll[0]!.id).toBe(STANDARD_RECEIPT.id)
  })

  it('also has a sheet invoice, which is a different document from a receipt', async () => {
    const sheet = await listFormats(fx.db, 'a4')
    expect(sheet).toHaveLength(1)
    expect(sheet[0]!.name).toBe('A4 invoice')
  })

  it('puts the customer in a block of their own on the sheet, where there is room', async () => {
    const sheet = (await listFormats(fx.db, 'a4'))[0]!
    expect(sheet.blocks.find((b) => b.kind === 'party')!.on).toBe(true)
    expect(sheet.blocks.find((b) => b.kind === 'signature')!.on).toBe(true)
  })

  it('stores that format exactly as the code describes it', async () => {
    const stored = await loadFormat(fx.db, STANDARD_RECEIPT.id)
    expect(stored!.blocks).toEqual(STANDARD_RECEIPT.blocks)
  })

  it('marks it as the one that came with the product', async () => {
    const stored = await loadFormat(fx.db, STANDARD_RECEIPT.id)
    expect(stored!.builtIn).toBe(true)
  })
})

describe('saving a format the shop designed', () => {
  it('keeps it, and hands back the id to reopen it with', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Counter slip', paper: 'thermal_58', kinds: ['bill'],
      blocks: [{ kind: 'shop', on: true }, ITEMS],
    })

    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const back = await loadFormat(fx.db, saved.id)
    expect(back!.name).toBe('Counter slip')
    expect(back!.paper).toBe('thermal_58')
  })

  it('records who changed the receipt, which is the point of having a gate on it', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Counter slip', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')

    const rows = await auditRows(saved.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('create')
    expect(rows[0]!.actor_id).toBe(fx.adminId)
  })

  it('records an edit as a change rather than as a second format', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Counter slip', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')

    await saveFormat(fx.db, ctx(), {
      id: saved.id, name: 'Counter slip v2', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })

    expect(await listFormats(fx.db, 'thermal_58')).toHaveLength(1)
    expect((await auditRows(saved.id)).map((r) => r.action)).toEqual(['create', 'update'])
  })

  it('keeps the version before the edit, so a change can be read back', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Counter slip', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')

    await saveFormat(fx.db, ctx(), {
      id: saved.id, name: 'Renamed', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })

    const rows = await auditRows(saved.id)
    expect(rows[1]!.diff).toContain('Counter slip')
    expect(rows[1]!.diff).toContain('Renamed')
  })

  it('trims a name padded with spaces rather than storing it that way', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: '  Counter slip  ', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')

    expect((await loadFormat(fx.db, saved.id))!.name).toBe('Counter slip')
  })
})

describe('what the shop is not allowed to save', () => {
  it('refuses a receipt with no items, and says so rather than storing it', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Total only', paper: 'thermal_58', kinds: ['bill'],
      blocks: [{ kind: 'totals', on: true }],
    })

    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.problems).toContainEqual({ code: 'NO_ITEMS_BLOCK' })
  })

  it('stores nothing at all when it refuses', async () => {
    await saveFormat(fx.db, ctx(), {
      name: '', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    expect(await listFormats(fx.db, 'thermal_58')).toHaveLength(0)
  })

  it('writes no history for a save that did not happen', async () => {
    await saveFormat(fx.db, ctx(), {
      name: '', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    const all = await fx.db.query(`SELECT id FROM audit_log WHERE entity = 'doc_format'`)
    expect(all).toHaveLength(0)
  })
})

describe('deleting a format', () => {
  it('removes one the shop made', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Counter slip', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')

    expect(await deleteFormat(fx.db, ctx(), saved.id)).toEqual({ ok: true })
    expect(await loadFormat(fx.db, saved.id)).toBeNull()
  })

  it('refuses to remove the one that came with the product', async () => {
    // It is the floor the print path lands on when anything else is missing.
    const gone = await deleteFormat(fx.db, ctx(), STANDARD_RECEIPT.id)
    expect(gone).toEqual({ ok: false, code: 'BUILT_IN' })
    expect(await loadFormat(fx.db, STANDARD_RECEIPT.id)).not.toBeNull()
  })

  it('says so plainly when there was nothing there', async () => {
    expect(await deleteFormat(fx.db, ctx(), 'never-existed')).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('records who removed it', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Counter slip', paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')
    await deleteFormat(fx.db, ctx(), saved.id)

    expect((await auditRows(saved.id)).map((r) => r.action)).toEqual(['create', 'delete'])
  })
})

describe('choosing the format to print with', () => {
  it('uses the one that says it prints bills', async () => {
    const chosen = await formatFor(fx.db, { kind: 'bill', channel: 'roll' })
    expect(chosen.id).toBe(STANDARD_RECEIPT.id)
  })

  it('keeps the till and the sheet as separate choices', async () => {
    // Picking an A4 layout must not quietly change what the till prints.
    expect((await formatFor(fx.db, { kind: 'bill', channel: 'roll' })).paper).toBe('thermal_80')
    expect((await formatFor(fx.db, { kind: 'bill', channel: 'sheet' })).paper).toBe('a4')
  })

  it('falls back to the shipped format rather than failing, when nothing matches', async () => {
    // Printing is not a place to fail. A shop mid-sale needs paper out of the
    // machine more than it needs to be told a row is missing.
    const chosen = await formatFor(fx.db, { kind: 'quotation', channel: 'roll' })
    expect(chosen).toEqual(STANDARD_RECEIPT)
  })

  it('falls back rather than crashing on a format that cannot be read', async () => {
    await fx.db.execute(`UPDATE doc_formats SET blocks = 'not json at all' WHERE id = ?`, [STANDARD_RECEIPT.id])

    expect(await listFormats(fx.db, 'thermal_80')).toHaveLength(0)
    expect(await formatFor(fx.db, { kind: 'bill', channel: 'roll' })).toEqual(STANDARD_RECEIPT)
  })
})

describe('a format stored before a block existed', () => {
  it('gains the new block rather than silently dropping it off the paper', async () => {
    await fx.db.execute(
      `UPDATE doc_formats SET blocks = ? WHERE id = ?`,
      [JSON.stringify([{ kind: 'items', on: true }]), STANDARD_RECEIPT.id],
    )

    const back = await loadFormat(fx.db, STANDARD_RECEIPT.id)
    expect(back!.blocks.find((b) => b.kind === 'terms')).toEqual({ kind: 'terms', on: true })
  })
})

describe('choosing which format bills print with', () => {
  async function aSecondFormat(name = 'Counter slip') {
    const saved = await saveFormat(fx.db, ctx(), {
      name, paper: 'thermal_58', kinds: ['bill'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')
    return saved.id
  }

  it('starts on the format the product ships with', async () => {
    expect(await chosenFormatId(fx.db, 'bill', 'roll')).toBeNull()
    expect((await formatFor(fx.db, { kind: 'bill', channel: 'roll' })).id).toBe(STANDARD_RECEIPT.id)
  })

  it('prints with the one the shop picked', async () => {
    const id = await aSecondFormat()
    expect(await chooseFormat(fx.db, ctx(), 'bill', id)).toEqual({ ok: true })

    expect((await formatFor(fx.db, { kind: 'bill', channel: 'roll' })).id).toBe(id)
  })

  it('refuses a format that does not print that kind of document', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Quote sheet', paper: 'thermal_58', kinds: ['quotation'], blocks: [ITEMS],
    })
    if (!saved.ok) throw new Error('the save did not go through')

    expect(await chooseFormat(fx.db, ctx(), 'bill', saved.id)).toEqual({ ok: false, code: 'WRONG_KIND' })
  })

  it('refuses a format that is not there', async () => {
    expect(await chooseFormat(fx.db, ctx(), 'bill', 'never-existed'))
      .toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('records who changed what the shop prints', async () => {
    const id = await aSecondFormat()
    await chooseFormat(fx.db, ctx(), 'bill', id)

    const rows = await auditRows(id)
    expect(rows.map((r) => r.action)).toEqual(['create', 'update'])
    expect(rows[1]!.actor_id).toBe(fx.adminId)
  })

  it('goes back to the shipped format when the chosen one is deleted', async () => {
    // Otherwise the setting points at a ghost: the printer quietly uses the
    // standard while the screen still names the format that is gone.
    const id = await aSecondFormat()
    await chooseFormat(fx.db, ctx(), 'bill', id)
    await deleteFormat(fx.db, ctx(), id)

    expect(await chosenFormatId(fx.db, 'bill', 'roll')).toBeNull()
    expect((await formatFor(fx.db, { kind: 'bill', channel: 'roll' })).id).toBe(STANDARD_RECEIPT.id)
  })

  it('leaves a choice for another document kind alone when one is deleted', async () => {
    const billFormat = await aSecondFormat('For bills')
    await chooseFormat(fx.db, ctx(), 'bill', billFormat)

    const other = await saveFormat(fx.db, ctx(), {
      name: 'For quotes', paper: 'thermal_58', kinds: ['quotation'], blocks: [ITEMS],
    })
    if (!other.ok) throw new Error('the save did not go through')
    await chooseFormat(fx.db, ctx(), 'quotation', other.id)

    await deleteFormat(fx.db, ctx(), billFormat)

    expect(await chosenFormatId(fx.db, 'quotation', 'roll')).toBe(other.id)
  })
})

describe('what the printer actually receives', () => {
  const doc: ReceiptDoc = {
    shop: { name: 'TRT Stationery', address: 'Perambalur 621212', phone: '9047191778', gstin: '33ALNPJ1906G1ZC' },
    docNo: 'INV/MR/26-27/00023',
    postingDate: '2026-09-12',
    cashier: 'admin',
    customerName: 'Sri Vidya School',
    items: [{ name: 'Ball Pen Blue', qty: fromUnits(12), saleUnit: 'piece', rate: rupees(10), lineTotal: rupees(120) }],
    subtotal: rupees(120),
    discount: rupees(0),
    taxableTotal: rupees(101.69),
    cgst: rupees(9.15),
    sgst: rupees(9.15),
    igst: 0 as Money,
    grandTotal: rupees(120),
    payments: [{ method: 'cash', amount: rupees(120) }],
  }

  /** What `print.ts` does: ask which format, then render with it. */
  async function whatWouldPrint() {
    return buildReceipt(doc, await formatFor(fx.db, { kind: 'bill', channel: 'roll' }))
  }

  it('prints the shipped receipt for a shop that has changed nothing', async () => {
    expect(await whatWouldPrint()).toBe(buildReceipt(doc))
  })

  it('prints the shop own format once it has chosen one', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'No footer', paper: 'thermal_80', kinds: ['bill'],
      blocks: STANDARD_RECEIPT.blocks.map((b) => (b.kind === 'terms' ? { ...b, on: false } : b)),
    })
    if (!saved.ok) throw new Error('the save did not go through')
    await chooseFormat(fx.db, ctx(), 'bill', saved.id)

    const receipt = await whatWouldPrint()
    expect(receipt.includes('Goods once sold')).toBe(false)
    expect(receipt.includes('INV/MR/26-27/00023')).toBe(true)
  })

  it('narrows the paper when the shop switches to the smaller roll', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Small roll', paper: 'thermal_58', kinds: ['bill'], blocks: STANDARD_RECEIPT.blocks,
    })
    if (!saved.ok) throw new Error('the save did not go through')
    await chooseFormat(fx.db, ctx(), 'bill', saved.id)

    for (const line of visibleLines(await whatWouldPrint())) {
      expect(line.length).toBeLessThanOrEqual(rollColumns('thermal_58'))
    }
  })

  it('still prints when the chosen format has been deleted out from under it', async () => {
    const saved = await saveFormat(fx.db, ctx(), {
      name: 'Temporary', paper: 'thermal_80', kinds: ['bill'], blocks: STANDARD_RECEIPT.blocks,
    })
    if (!saved.ok) throw new Error('the save did not go through')
    await chooseFormat(fx.db, ctx(), 'bill', saved.id)
    await deleteFormat(fx.db, ctx(), saved.id)

    expect(await whatWouldPrint()).toBe(buildReceipt(doc))
  })
})
