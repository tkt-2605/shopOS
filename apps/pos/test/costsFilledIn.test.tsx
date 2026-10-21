import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import {
  migrate, bootstrap, newId, loadFeatures, createStockEntry, submitStockEntry, loadDocument, listDocuments,
  type SqlDriver, type BootstrapResult, type CostHint,
} from '@shopos/core'
/* Reached around `@shopos/core` on purpose: see `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { loadPermissions } from '../../../packages/core/src/integrity/permissions'
import { fromUnits } from '../../../packages/core/src/quantity'

/**
 * A cost somebody is about to type, filled in for them: the last price paid,
 * on Stock In and on a purchase order, and the item's own cost price on its
 * form. Each screen says where the figure came from, and none of them lets a
 * filled-in figure change what it did not used to.
 */

let db: SqlDriver
let seed: BootstrapResult
let paper: string
let supplierId: string
let adminId: string
let core: Record<string, unknown>

vi.mock('../src/core/CoreProvider', () => ({
  useCore: () => core,
  useUser: () => core['user'],
  useDb: () => core['db'],
}))
vi.mock('../src/core/attachments', () => ({
  storeFile: vi.fn(), readFile: vi.fn(), deleteFile: vi.fn(), filesFromTransfer: () => [], nameFor: () => '',
}))

const { default: StockIn } = await import('../src/pages/StockIn')
const { Draft } = await import('../src/ui/documentDesk/Draft')
const { ProductForm } = await import('../src/pages/inventory/ProductForm')
const { BLANK } = await import('../src/pages/inventory/draft')
const { useParentSearch } = await import('../src/pages/inventory/useParentSearch')

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'TRT Stationery' })

  adminId = newId()
  const now = new Date().toISOString()
  const roleId = seed.roleIds['Admin']!
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, roleId, now, now],
  )
  paper = newId()
  // Sells at ₹340 with 18% GST; bought last at ₹285 before tax.
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
     VALUES (?, 'A4 Copier Paper 500 sheets', 34000, 1800, '4802', ?, ?)`,
    [paper, now, now],
  )
  supplierId = newId()
  await db.execute(
    'INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [supplierId, 'Sakthi Agencies', now, now],
  )

  core = {
    db,
    features: await loadFeatures(db),
    taxScheme: 'regular',
    user: {
      id: adminId, username: 'admin', fullName: 'Administrator', roleId, roleName: 'Admin',
      permissions: await loadPermissions(db, roleId),
    },
  }
})

afterEach(async () => {
  cleanup()
  await db.close()
})

async function boughtAt(paise: number) {
  const entry = await createStockEntry(db, {
    entryType: 'purchase', supplierId, supplierName: 'Sakthi Agencies', reference: '',
    lines: [{ productId: paper, qty: fromUnits(10), unitCost: paise as never }],
    actorId: adminId,
  })
  if (!entry.ok) throw new Error(entry.code)
  await submitStockEntry(db, { entryId: entry.entryId, actorId: adminId })
}

async function addPaper() {
  await act(() => new Promise((r) => setTimeout(r, 30)))
  const box = screen.getByPlaceholderText(/Scan or search an item/)
  fireEvent.change(box, { target: { value: 'A4' } })
  await waitFor(() => expect(screen.getAllByText(/A4 Copier Paper/).length).toBeGreaterThan(0))
  fireEvent.keyDown(box, { key: 'Enter' })
}

const costBox = () => document.querySelectorAll<HTMLInputElement>('table input.qty-input')

describe('stock in', () => {
  it('fills in the last price paid and says where it came from', async () => {
    await boughtAt(28500)
    render(<StockIn />)
    await addPaper()
    await waitFor(() => expect(screen.getByText(/last paid ₹285\.00/)).toBeTruthy())
    expect([...costBox()].some((i) => i.value === '285.00')).toBe(true)
    expect(screen.getByText(/Sakthi Agencies/, { selector: '.src' })).toBeTruthy()
  })

  it('drops a filled-in cost from goods going out, so wastage leaves at the shelf’s cost', async () => {
    await boughtAt(28500)
    render(<StockIn />)
    await addPaper()
    await waitFor(() => expect(screen.getByText(/last paid ₹285\.00/)).toBeTruthy())
    fireEvent.change(document.getElementById('entry-type')!, { target: { value: 'wastage' } })
    await waitFor(() => expect([...costBox()].some((i) => i.value === '285.00')).toBe(false))
  })

  it('has one cost box, and a switch that shows the same cost the other way', async () => {
    render(<StockIn />)
    await addPaper()
    const box = await screen.findByLabelText('Unit cost') as HTMLInputElement
    fireEvent.click(screen.getByText('Incl. GST'))
    // ₹118 at 18% is ₹100 of paper.
    fireEvent.change(box, { target: { value: '118' } })
    fireEvent.click(screen.getByText('Excl. GST'))
    await waitFor(() => expect(box.value).toBe('100.00'))
    fireEvent.change(box, { target: { value: '200' } })
    fireEvent.click(screen.getByText('Incl. GST'))
    await waitFor(() => expect(box.value).toBe('236.00'))
    expect(screen.queryByLabelText(/with GST/)).toBeNull()
  })

  it('says each thing once: an amount that follows the switch, and the shelf under the item', async () => {
    render(<StockIn />)
    await addPaper()
    fireEvent.click(await screen.findByText('Incl. GST'))
    fireEvent.change(screen.getByLabelText('Unit cost'), { target: { value: '118' } })
    await waitFor(() => expect(screen.getByText('Amount incl. GST')).toBeTruthy())
    const heads = [...document.querySelectorAll('thead th')].map((th) => th.textContent ?? '')
    expect(heads.some((h) => /^Tax$|On hand after|Value excl/.test(h))).toBe(false)
    expect(screen.getAllByText('₹118.00').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Excl. GST'))
    await waitFor(() => expect(screen.getByText('Amount excl. GST')).toBeTruthy())
    expect(screen.getByText(/on hand 0 → 1 piece/)).toBeTruthy()
  })

  it('says when the price to sell at is below what this delivery cost', async () => {
    await boughtAt(28500)
    render(<StockIn />)
    await addPaper()
    await screen.findByText(/last paid ₹285\.00/)
    // ₹340 with 18% in it is ₹288.14 of paper, above ₹285: nothing to say.
    expect(screen.queryByText(/below this cost/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Sell at'), { target: { value: '300' } })
    await waitFor(() => expect(screen.getByText('below this cost (₹285.00)')).toBeTruthy())
  })

  it('posts the cost before GST when it was typed with GST', async () => {
    render(<StockIn />)
    await addPaper()
    fireEvent.click(await screen.findByText('Incl. GST'))
    fireEvent.change(screen.getByLabelText('Unit cost'), { target: { value: '118' } })
    fireEvent.click(screen.getByText('Post entry'))
    await waitFor(() => expect(screen.getByText(/Stock updated/)).toBeTruthy())
    const row = await db.get<{ unit_cost: number }>('SELECT unit_cost FROM stock_entry_items WHERE product_id = ?', [paper])
    expect(row?.unit_cost).toBe(10000)
  })

  it('leaves the box empty for an item with no cost known, and warns as it always has', async () => {
    render(<StockIn />)
    await addPaper()
    await waitFor(() => expect(screen.getByText(/^no cost/)).toBeTruthy())
    expect([...costBox()].every((i) => i.value !== '285.00')).toBe(true)
  })
})

describe('a purchase order', () => {
  const config = {
    kinds: ['purchase_order' as const],
    party: 'supplier' as const,
    labels: { purchase_order: { name: 'Purchase order', plural: 'Purchase orders', note: '' } },
  }

  function draft(onDone = vi.fn()) {
    render(<Draft config={config} kind="purchase_order" onClose={vi.fn()} onDone={onDone}
      onError={vi.fn()} registerId={seed.registerId} userId={adminId} />)
    return onDone
  }

  async function addToOrder() {
    const box = screen.getByPlaceholderText(/Scan or search an item/)
    fireEvent.change(box, { target: { value: 'A4' } })
    await waitFor(() => expect(screen.getAllByText(/A4 Copier Paper/).length).toBeGreaterThan(0))
    fireEvent.keyDown(box, { key: 'Enter' })
  }

  const rateBox = () => screen.getByLabelText('Rate') as HTMLInputElement

  it('starts each item at its last cost, never the selling price', async () => {
    await boughtAt(28500)
    draft()
    await addToOrder()
    await waitFor(() => expect(rateBox().value).toBe('285.00'))
    expect(screen.getByText(/last paid ₹285\.00/)).toBeTruthy()
    expect(screen.queryByText(/A blank rate is filled in/)).toBeNull()
  })

  it('shows the filled-in cost both ways, and saves it before GST', async () => {
    await boughtAt(28500)
    const onDone = draft()
    await addToOrder()
    await waitFor(() => expect(rateBox().value).toBe('285.00'))
    // ₹285 and 18%: ₹25.65 each of CGST and SGST.
    fireEvent.click(screen.getByText('Incl. GST'))
    await waitFor(() => expect(rateBox().value).toBe('336.30'))

    fireEvent.change(document.getElementById('doc-party')!, { target: { value: supplierId } })
    fireEvent.click(screen.getByText('Save as draft'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const [order] = await listDocuments(db, { kind: 'purchase_order', status: 'draft' })
    const doc = await loadDocument(db, order!.id)
    expect(doc!.items[0]).toMatchObject({ rate: 28500, rateIncludesTax: false })
  })

  it('keeps a rate typed with GST as typed, and the service takes it apart', async () => {
    const onDone = draft()
    await addToOrder()
    await waitFor(() => expect(screen.getByText(/no cost known/)).toBeTruthy())
    fireEvent.click(screen.getByText('Incl. GST'))
    fireEvent.change(rateBox(), { target: { value: '354' } })
    fireEvent.click(screen.getByText('Excl. GST'))
    await waitFor(() => expect(rateBox().value).toBe('300.00'))
    fireEvent.change(document.getElementById('doc-party')!, { target: { value: supplierId } })
    fireEvent.click(screen.getByText('Save as draft'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const [order] = await listDocuments(db, { kind: 'purchase_order', status: 'draft' })
    const doc = await loadDocument(db, order!.id)
    expect(doc!.items[0]).toMatchObject({ rate: 35400, rateIncludesTax: true, taxableValue: 30000 })
  })

  it('opens a saved draft again as it was, and saves a change into the same draft', async () => {
    const onDone = draft()
    await addToOrder()
    await waitFor(() => expect(screen.getByText(/no cost known/)).toBeTruthy())
    fireEvent.change(rateBox(), { target: { value: '300' } })
    fireEvent.change(document.getElementById('doc-party')!, { target: { value: supplierId } })
    fireEvent.click(screen.getByText('Save as draft'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    cleanup()

    const [saved] = await listDocuments(db, { kind: 'purchase_order', status: 'draft' })
    const editing = await loadDocument(db, saved!.id)
    const done = vi.fn()
    render(<Draft config={config} kind="purchase_order" editing={editing} onClose={vi.fn()} onDone={done}
      onError={vi.fn()} registerId={seed.registerId} userId={adminId} />)
    expect(screen.getByText(`Edit draft purchase order ${saved!.docNo}`)).toBeTruthy()
    await waitFor(() => expect(rateBox().value).toBe('300.00'))
    expect((document.getElementById('doc-party') as HTMLSelectElement).value).toBe(supplierId)

    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '4' } })
    fireEvent.click(screen.getByText('Save draft'))
    await waitFor(() => expect(done).toHaveBeenCalledWith(`Draft ${saved!.docNo} saved. It is under Drafts until you issue it.`))

    const drafts = await listDocuments(db, { kind: 'purchase_order', status: 'draft' })
    expect(drafts.map((d) => d.id)).toEqual([saved!.id])
    const doc = await loadDocument(db, saved!.id)
    expect(doc!.items).toHaveLength(1)
    expect(doc!.items[0]).toMatchObject({ qty: 40000, rate: 30000, rateIncludesTax: false })
  })
})

describe('the item form', () => {
  /** The form as the page holds it, with the page's own "Version of" search. */
  function Form({ draft, lastCost }: { draft: typeof BLANK; lastCost?: CostHint }) {
    const parent = useParentSearch(db, draft, vi.fn())
    return (
      <ProductForm draft={draft} setDraft={vi.fn()} categories={[]} newCategory="" setNewCategory={vi.fn()}
        onAddCategory={vi.fn()} parentName={undefined} parent={parent} lastCost={lastCost ?? null} />
    )
  }

  it('hides the GST boxes behind No GST, and keeps what they held', async () => {
    const draft = { ...BLANK, noGst: true, taxPercent: '18', hsnCode: '4802' }
    render(<Form draft={draft} />)
    expect(document.getElementById('p-gst')).toBeNull()
    expect(document.getElementById('p-hsn')).toBeNull()
    expect((document.getElementById('p-no-gst') as HTMLInputElement).checked).toBe(true)
  })

  it('asks for a cost price, and shows the last price paid beside it', async () => {
    const draft = { ...BLANK, id: paper, name: 'A4', costPrice: '280.00' }
    render(<Form draft={draft} lastCost={{
      productId: paper, unitCost: 28500 as never, source: 'purchase', postedOn: '2026-10-15', supplierName: 'Sakthi Agencies', taxPerUnit: 0 as never,
    }} />)
    expect((document.getElementById('p-cost') as HTMLInputElement).value).toBe('280.00')
    expect(screen.getByText(/Latest, before GST: last paid ₹285\.00 on 15 Oct 2026 · Sakthi Agencies/)).toBeTruthy()
  })
})
