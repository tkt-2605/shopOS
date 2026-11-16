import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { planRemoval, removeProducts, HISTORY_TABLES, OWNED_TABLES } from '../src/services/productRemoval.js'
import { planImport, applyImport } from '../src/services/import.js'
import { searchProducts, findByBarcode } from '../src/repos/catalog/products.js'
import { createUser } from '../src/services/auth.js'
import { PermissionError } from '../src/integrity/permissions.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Several items gone at once: deleted where nothing points at them, out of use
 * where the books do. A shop that made its colours as separate items before
 * variants, and has made them again as a family, clears the old ones in one go.
 */

let fx: Fixture
const ctx = { get actorId(): string { return fx.adminId } }
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

/** An item with history: its opening stock is a stock entry and a ledger line. */
async function stocked(name: string): Promise<string> {
  await applyImport(fx.db, ctx, await planImport(fx.db, `name,rate,cost,openingqty\r\n${name},10,5,4\r\n`))
  const [row] = await fx.db.query<{ id: string }>(`SELECT id FROM products WHERE name = ?`, [name])
  return row!.id
}

describe('what counts as history', () => {
  it('sorts every table that names a product', async () => {
    /* A new table pointing at products has to be put on one side: history,
       which keeps an item, or the item's own, which goes with it. */
    // raw: the schema's own foreign keys, read table by table
    const tables = await fx.db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    const naming: string[] = []
    for (const { name } of tables) {
      const keys = await fx.db.query<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list(?)`, [name])
      if (keys.some((k) => k.table === 'products') && name !== 'products') naming.push(name)
    }
    expect(naming.sort()).toEqual([...HISTORY_TABLES, ...OWNED_TABLES].sort())
  })
})

describe('removing several items', () => {
  it('deletes the ones nothing points at, and frees their barcodes', async () => {
    const a = await makeProduct(fx.db, { name: 'XO pen blue', barcode: '111' })
    const b = await makeProduct(fx.db, { name: 'XO pen red', barcode: '222' })
    const kept = await makeProduct(fx.db, { name: 'Eraser' })

    const plan = await planRemoval(fx.db, [a, b])
    expect(plan).toMatchObject({ delete: 2, retire: 0, keep: 0 })
    // Nothing yet: the plan only says.
    expect(await findByBarcode(fx.db, '111')).not.toBeNull()

    expect(await removeProducts(fx.db, ctx, [a, b])).toEqual({ deleted: 2, retired: 0, kept: 0 })
    const left = await searchProducts(fx.db, { limit: null, includeInactive: true })
    expect(left.map((p) => p.id)).toEqual([kept])
    expect(await findByBarcode(fx.db, '111')).toBeNull()

    // The code is free: a new item may carry it, and the scanner finds that one.
    const again = await makeProduct(fx.db, { name: 'XO pen (Blue)', barcode: '111' })
    expect((await findByBarcode(fx.db, '111'))?.id).toBe(again)
  })

  it('takes an item with history out of use instead, and says so first', async () => {
    const sold = await stocked('Old pencil')
    const fresh = await makeProduct(fx.db, { name: 'Typo pencil' })

    const plan = await planRemoval(fx.db, [sold, fresh])
    expect(plan.rows.find((r) => r.productId === sold)).toMatchObject({ action: 'retire', reason: 'HAS_HISTORY' })
    expect(plan.rows.find((r) => r.productId === fresh)).toMatchObject({ action: 'delete', reason: null })

    expect(await removeProducts(fx.db, ctx, [sold, fresh])).toEqual({ deleted: 1, retired: 1, kept: 0 })
    const [row] = await fx.db.query<{ is_active: number; deleted_at: string | null }>(
      `SELECT is_active, deleted_at FROM products WHERE id = ?`, [sold])
    expect(row).toEqual({ is_active: 0, deleted_at: null })
    // Its stock is still counted: retiring is not a write-off.
    const [stock] = await fx.db.query<{ n: number }>(`SELECT count(*) AS n FROM stock_ledger WHERE product_id = ?`, [sold])
    expect(stock!.n).toBeGreaterThan(0)

    // Asked again, there is nothing more to do to it.
    const twice = await planRemoval(fx.db, [sold])
    expect(twice.rows[0]).toMatchObject({ action: 'keep', reason: 'ALREADY_RETIRED' })
  })

  it('keeps a family whose variants were not all chosen', async () => {
    const pen = await makeProduct(fx.db, { name: 'XO pen' })
    const blue = await makeProduct(fx.db, { name: 'XO pen (Blue)' })
    const red = await makeProduct(fx.db, { name: 'XO pen (Red)' })
    await fx.db.execute(`UPDATE products SET parent_product_id = ? WHERE id IN (?, ?)`, [pen, blue, red])

    const part = await planRemoval(fx.db, [pen, blue])
    expect(part.rows.find((r) => r.productId === pen)).toMatchObject({ action: 'keep', reason: 'HAS_VARIANTS' })
    expect(part.rows.find((r) => r.productId === blue)).toMatchObject({ action: 'delete' })

    const whole = await planRemoval(fx.db, [pen, blue, red])
    expect(whole).toMatchObject({ delete: 3, retire: 0, keep: 0 })
  })

  it('retires a family whose variants stay as history', async () => {
    const pen = await makeProduct(fx.db, { name: 'XO pen' })
    const blue = await stocked('XO pen (Blue)')
    await fx.db.execute(`UPDATE products SET parent_product_id = ? WHERE id = ?`, [pen, blue])

    const plan = await planRemoval(fx.db, [pen, blue])
    expect(plan.rows.find((r) => r.productId === pen)).toMatchObject({ action: 'retire', reason: 'HAS_HISTORY' })
    expect(plan.rows.find((r) => r.productId === blue)).toMatchObject({ action: 'retire', reason: 'HAS_HISTORY' })
  })

  it('lets the same row be imported again after a delete', async () => {
    /* The import derives a new item's id from its barcode and name, and the
       deleted row still holds that id and that code. */
    const row = 'name,brand,barcode,unit,rate\r\nXO PEN BLUE,FLAIR,8901234500118,piece,10\r\n'
    await applyImport(fx.db, ctx, await planImport(fx.db, row))
    const [first] = await fx.db.query<{ id: string }>(`SELECT id FROM products`)
    await removeProducts(fx.db, ctx, [first!.id])

    const again = await planImport(fx.db, row)
    expect(again.rows[0]).toMatchObject({ problem: null, action: 'create' })
    await applyImport(fx.db, ctx, again)
    const found = await findByBarcode(fx.db, '8901234500118')
    expect(found?.name).toBe('XO PEN BLUE')
    expect(found?.id).not.toBe(first!.id)
  })

  it('is refused to a role without delete on products', async () => {
    const made = await createUser(fx.db, {
      username: 'stock', password: 'counter-9', roleId: fx.seed.roleIds['Stockist']!, actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(made.code)
    const item = await makeProduct(fx.db, { name: 'Eraser' })
    await expect(removeProducts(fx.db, { actorId: made.userId }, [item])).rejects.toBeInstanceOf(PermissionError)
    expect(await searchProducts(fx.db, { limit: null })).toHaveLength(1)
  })
})
