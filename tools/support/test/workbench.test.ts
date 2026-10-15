import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@shopos/core/node'
import { freshDb, makeProduct } from '../../../packages/core/test/helpers.js'
import { createBill, submitBill } from '../../../packages/core/src/services/billing.js'
import { createStockEntry, submitStockEntry } from '../../../packages/core/src/services/stockEntry.js'
import { rupees } from '../../../packages/core/src/money.js'
import { fromUnits } from '../../../packages/core/src/quantity.js'
import { loadShop } from '../src/load.js'
import { checkShop, render } from '../src/check.js'
import { findDocument, timeline, renderTimeline } from '../src/timeline.js'
import { diffShops, renderDiff } from '../src/diff.js'
import { seal, makeVendorKey, publicOf } from '../src/sod.js'

/**
 * The workbench on a real shop's database, made by core's own services:
 * every check reads it the way the till would, a document's history comes
 * back in order, two tills' differences are found, and the file handed in is
 * never touched.
 */

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** A shop with one paid bill, written to a file, as a till would leave it. */
async function aShop(): Promise<{ file: string; billNo: string }> {
  const fx = await freshDb()
  const productId = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  // Stock in the way a shop takes it in, so the books hear of it too.
  const entry = await createStockEntry(fx.db, {
    entryType: 'purchase', lines: [{ productId, qty: fromUnits(20), unitCost: rupees(50) }], actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error(entry.code)
  const received = await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
  if (!received.ok) throw new Error(received.code)
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId, qty: fromUnits(2) }], actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const paid = await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
  if (!paid.ok) throw new Error(paid.code)
  const billNo = (await fx.db.get<{ doc_no: string }>('SELECT doc_no FROM bills WHERE id = ?', [draft.billId]))!.doc_no

  const dir = mkdtempSync(join(tmpdir(), 'shopos-workbench-'))
  dirs.push(dir)
  const file = join(dir, 'shop.db')
  await fx.db.execute(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  await fx.db.close()
  return { file, billNo }
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('check', () => {
  it('finds a healthy shop healthy', async () => {
    const { file } = await aShop()
    const shop = await loadShop(file)
    try {
      const sections = await checkShop(shop.db)
      expect(sections.filter((s) => !s.ok).map((s) => s.title + ': ' + s.lines.join(' | '))).toEqual([])
      expect(render(sections)).toContain('Every voucher balances.')
    } finally {
      await shop.close()
    }
  })

  it('finds a cached figure that has drifted, and leaves the file it was given alone', async () => {
    const { file } = await aShop()
    const raw = openDatabase(file)
    await raw.execute('UPDATE product_stock SET qty_on_hand = qty_on_hand + 50000')
    await raw.close()
    const before = sha(file)

    const shop = await loadShop(file)
    try {
      const sections = await checkShop(shop.db)
      const figures = sections.find((s) => s.title === 'Cached figures')!
      expect(figures.ok).toBe(false)
      expect(figures.lines.join('\n')).toMatch(/stock on hand: 1 differ/)
    } finally {
      await shop.close()
    }
    expect(sha(file)).toBe(before)
  })

  it('opens a file a till sealed, with the vendor key, and says who sent it', async () => {
    const { file } = await aShop()
    const key = makeVendorKey()
    const dir = mkdtempSync(join(tmpdir(), 'shopos-workbench-sod-'))
    dirs.push(dir)
    const sod = join(dir, 'sent.sod')
    writeFileSync(sod, seal({
      format: 1, shopId: 'shop-1', deviceId: 'till-1', appVersion: '0.3.0', madeAt: '2026-10-16T00:00:00Z',
      madeBy: 'owner', note: 'bills not crossing', anonymised: true, customersHidden: 0,
    }, readFileSync(file), publicOf(key)))
    const keyFile = join(dir, 'key.json')
    writeFileSync(keyFile, JSON.stringify(key))

    const shop = await loadShop(sod, { key: keyFile })
    try {
      expect(shop.manifest?.note).toBe('bills not crossing')
      expect((await checkShop(shop.db)).every((s) => s.ok)).toBe(true)
    } finally {
      await shop.close()
    }
  })
})

describe('timeline', () => {
  it('tells one bill from creation to the books and the stock, in order', async () => {
    const { file, billNo } = await aShop()
    const shop = await loadShop(file)
    try {
      const doc = await findDocument(shop.db, billNo)
      expect(doc?.table).toBe('bills')
      const events = await timeline(shop.db, doc!)
      const text = renderTimeline(doc!, events)
      expect(text).toContain(`${billNo} created`)
      expect(text).toMatch(/audit: submit/)
      expect(text).toMatch(/books: \d+ entries/)
      expect(text).toMatch(/stock: 1 movement/)
      expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort())
    } finally {
      await shop.close()
    }
  })

  it('says nothing found for a number the shop never issued', async () => {
    const { file } = await aShop()
    const shop = await loadShop(file)
    try {
      expect(await findDocument(shop.db, 'XX/2627/99999')).toBeNull()
    } finally {
      await shop.close()
    }
  })
})

describe('diff', () => {
  it('finds the one row two tills hold differently, and nothing else', async () => {
    const { file } = await aShop()
    const other = join(file, '..', 'other.db')
    copyFileSync(file, other)
    const raw = openDatabase(other)
    await raw.execute("UPDATE products SET name = 'Renamed on the other till'")
    await raw.close()

    const a = await loadShop(file)
    const b = await loadShop(other)
    try {
      const same = await diffShops(a.db, a.db)
      expect(same).toEqual([])
      const found = await diffShops(a.db, b.db)
      expect(found.map((d) => d.table)).toEqual(['products'])
      expect(renderDiff(found)).toContain('1 row(s) differ: 1 products')
    } finally {
      await a.close()
      await b.close()
    }
  })
})
