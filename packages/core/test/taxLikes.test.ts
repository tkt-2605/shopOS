import { describe, it, expect, afterEach } from 'vitest'
import { taxLikeName, taxForHsn, nameWords } from '../src/repos/catalog/taxLikes.js'
import { newId } from '../src/ids.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * The HSN and GST an item probably has, from the shop's own items: a pair of
 * scissors is 8213 at 18% whoever made it, so the next pair should not mean
 * looking it up again.
 */

let fx: Fixture | undefined
afterEach(async () => { await fx?.db.close(); fx = undefined })

async function item(name: string, hsn: string | null, taxBp: number, cessBp = 0, active = 1) {
  const now = new Date().toISOString()
  await fx!.db.execute(
    `INSERT INTO products (id, name, hsn_code, tax_rate_bp, cess_rate_bp, base_rate, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1000, ?, ?, ?)`,
    [newId(), name, hsn, taxBp, cessBp, active, now, now],
  )
}

describe('the words of a name', () => {
  it('leave out the brand, sizes and short words, and take a plural back to one', () => {
    expect(nameWords('Kangaro Scissors 6 inch', 'Kangaro')).toEqual(['scissor', 'inch'])
    expect(nameWords('Pen', '')).toEqual(['pen'])
    expect(nameWords('A4 70 gsm', '')).toEqual(['gsm'])
  })
})

describe('codes on items named like this one', () => {
  it('offers the scissors code for a new brand of scissors', async () => {
    fx = await freshDb()
    await item('Kangaro Scissors', '8213', 1800)
    await item('Camlin Scissor small', '8213', 1800)
    await item('Classmate Notebook', '4820', 1200)
    const found = await taxLikeName(fx.db, 'Faber Scissors 8 inch', 'Faber')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ hsnCode: '8213', taxRateBp: 1800, cessRateBp: 0, items: 2 })
  })

  it('puts the item with most words in common first, and skips items with no code or out of use', async () => {
    fx = await freshDb()
    await item('Gel Pen Blue', '9608', 1800)
    await item('Gel Pen Black', '9608', 1800)
    await item('Pen Stand', '3926', 1800)
    await item('Pen drive', null, 1800)
    await item('Pen Refill', '9608', 1200, 0, 0)
    const found = await taxLikeName(fx.db, 'Gel Pen Red')
    expect(found.map((f) => f.hsnCode)).toEqual(['9608', '3926'])
    expect(found[0]!.items).toBe(2)
  })

  it('finds nothing for a name with nothing to match', async () => {
    fx = await freshDb()
    await item('Kangaro Scissors', '8213', 1800)
    expect(await taxLikeName(fx.db, 'Kangaro', 'Kangaro')).toEqual([])
    expect(await taxLikeName(fx.db, '')).toEqual([])
  })
})

describe('the rate for a code', () => {
  it('is the one most of the shop items with that code carry', async () => {
    fx = await freshDb()
    await item('Kangaro Scissors', '8213', 1800)
    await item('Camlin Scissor', '8213', 1800)
    await item('Old scissor typed wrong', '8213', 1200)
    expect(await taxForHsn(fx.db, ' 8213 ')).toMatchObject({ taxRateBp: 1800, items: 2 })
  })

  it('carries cess, and is nothing for a code the shop has not used', async () => {
    fx = await freshDb()
    await item('Cola 750ml', '2202', 2800, 1200)
    expect(await taxForHsn(fx.db, '2202')).toMatchObject({ taxRateBp: 2800, cessRateBp: 1200 })
    expect(await taxForHsn(fx.db, '8213')).toBeNull()
  })
})
