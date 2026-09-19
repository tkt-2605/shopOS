import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity,
  searchProducts, createStockEntry, submitStockEntry, listSuppliers, createSupplier,
  directionOf, signedQty, noCostBasis,
  type ProductListItem, type StockEntryType, type Supplier,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Field, Modal, Empty, Alert, Rupees } from '../ui/components'
import { Attachments } from '../ui/Attachments'
import { usePickList } from '../ui/PickList'

interface Line {
  key: string
  product: ProductListItem
  qty: string
  cost: string
}

/* Each note says which way the shelf moves, because that is what the list is
   choosing between. It used to ask for the direction back: “Wastage.
   Negative.” meant typing a minus into a box that starts at 1, having already
   picked Wastage from this list. `signedQty` settles it now. */
const TYPES: { id: StockEntryType; name: string; note: string }[] = [
  { id: 'purchase', name: 'Purchase', note: 'Goods received from a supplier. Stock goes up.' },
  { id: 'opening', name: 'Opening stock', note: 'What was on the shelf when you started. Stock goes up.' },
  { id: 'adjustment', name: 'Adjustment', note: 'Correcting a count. Type a minus to take stock off.' },
  { id: 'wastage', name: 'Wastage', note: 'Damaged or expired. Stock goes down by what you enter.' },
]

export default function StockIn() {
  const { db } = useCore()
  const user = useUser()
  const [entryType, setEntryType] = useState<StockEntryType>('purchase')
  const [supplierId, setSupplierId] = useState('')
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [newSupplier, setNewSupplier] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<ProductListItem[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string | null>(null)
  // Held with its id, not just its number: the distributor's paper bill is in
  // the shopkeeper's hand at this moment and nowhere else later.
  const [done, setDone] = useState<{ docNo: string; entryId: string } | null>(null)
  /* Items the shop has never recorded a rate for. Read once, because it
     answers a question about history that this screen is not changing until
     it saves — and the difference it makes is which of two warnings is true,
     not whether to warn. */
  const [unpriced, setUnpriced] = useState<Set<string>>(new Set())

  useEffect(() => {
    const id = setTimeout(() => { void searchProducts(db, { term, limit: 25 }).then(setResults) }, 140)
    return () => clearTimeout(id)
  }, [db, term])

  const loadSuppliers = useCallback(async () => {
    setSuppliers(await listSuppliers(db))
  }, [db])

  useEffect(() => { void loadSuppliers() }, [loadSuppliers])

  useEffect(() => {
    void noCostBasis(db).then((rows) => setUnpriced(new Set(rows.map((r) => r.productId))))
  }, [db])

  async function addSupplier() {
    if (!newSupplier) return
    setError(null)
    const result = await createSupplier(db, { name: newSupplier, actorId: user.id })
    if (!result.ok) {
      setError(result.code === 'NAME_TAKEN' ? 'That supplier already exists — pick it from the list.' : 'Give the supplier a name.')
      return
    }
    await loadSuppliers()
    setSupplierId(result.supplierId)
    setNewSupplier(null)
  }

  function add(product: ProductListItem) {
    setLines((prev) =>
      prev.some((l) => l.product.id === product.id)
        ? prev
        : [...prev, { key: `${product.id}-${Date.now()}`, product, qty: '1', cost: '' }])
    setTerm('')
  }

  const totalCost = lines.reduce((sum, l) => {
    const qty = Number(l.qty) || 0
    const cost = Money.parseMoney(l.cost) ?? 0
    return sum + Math.round(qty * cost)
  }, 0)

  async function submit() {
    setError(null)
    const entry = await createStockEntry(db, {
      entryType,
      supplierId: supplierId || null,
      supplierName: suppliers.find((x) => x.id === supplierId)?.name ?? null,
      reference: reference.trim(),
      lines: lines.map((l) => ({
        productId: l.product.id,
        /* As typed. `createStockEntry` applies the direction, so this screen
           and any other way in agree without each having to remember it. */
        qty: Quantity.fromUnits(Number(l.qty) || 0),
        unitCost: (Money.parseMoney(l.cost) ?? 0) as never,
      })),
      actorId: user.id,
    })

    if (!entry.ok) {
      setError(
        entry.code === 'NO_LINES' ? 'Add at least one item.'
        : entry.code === 'ZERO_QTY' ? 'Every line needs a quantity that is not zero.'
        : entry.code === 'INFLOW_NEEDS_POSITIVE_QTY' ? 'A purchase or opening entry cannot be negative. Use Adjustment instead.'
        : 'One of the items no longer exists.',
      )
      return
    }

    const submitted = await submitStockEntry(db, { entryId: entry.entryId, actorId: user.id })
    if (!submitted.ok) {
      setError('That would take stock below zero. Check the quantities.')
      return
    }

    setDone({ docNo: submitted.docNo, entryId: entry.entryId })
    setLines([])
    setReference('')
  }

  const pick = usePickList({
    count: results.length,
    resetKey: term,
    onPick: (i) => { const hit = results[i]; if (hit) add(hit) },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>
      {error && <Alert>{error}</Alert>}
      {done && (
        <div>
          <Alert kind="ok">Posted as {done.docNo}. Stock updated.</Alert>
          <Attachments
            entity="stock_entry"
            entityId={done.entryId}
            canEdit
            label={`Supplier's bill for ${done.docNo}`}
          />
        </div>
      )}

      <div className="card">
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Field label="Kind of entry" hint={TYPES.find((t) => t.id === entryType)?.note}>
            <select className="select" id="entry-type" value={entryType}
              onChange={(e) => setEntryType(e.target.value as StockEntryType)}>
              {TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field
            label="Supplier"
            hint={entryType === 'purchase' ? 'Links this delivery to a vendor, so cost history adds up per supplier.' : undefined}
          >
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                className="select" id="supplier" style={{ flex: 1, minWidth: 0 }}
                value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Not recorded</option>
                {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <button className="btn sm" onClick={() => setNewSupplier('')} title="Add a supplier">+</button>
            </div>
          </Field>
          <Field label="Bill or reference">
            <input className="input" id="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
      </div>

      {newSupplier !== null && (
        <Modal
          title="Add a supplier"
          onClose={() => setNewSupplier(null)}
          footer={<>
            <button className="btn" onClick={() => setNewSupplier(null)}>Cancel</button>
            <button className="btn primary" disabled={newSupplier.trim() === ''} onClick={() => void addSupplier()}>
              Add
            </button>
          </>}
        >
          <Field label="Name" hint="Phone, GSTIN and the rest can be filled in later on the Suppliers screen.">
            <input className="input" id="new-supplier" autoFocus value={newSupplier}
              onChange={(e) => setNewSupplier(e.target.value)} placeholder="Sakthi Agencies" />
          </Field>
        </Modal>
      )}

      <input className="input" placeholder="Scan or search an item to add" value={term}
        onChange={(e) => setTerm(e.target.value)} id="stock-search"
        onKeyDown={pick.searchKeyDown} />

      {term !== '' && (
        <div className="card" style={{ maxHeight: 220, overflow: 'auto' }}>
          <table>
            <tbody {...pick.listProps}>
              {results.map((p, i) => (
                <tr key={p.id} {...pick.rowProps(i)}>
                  <td>{p.name}{p.brand && <span style={{ color: 'var(--ink-3)' }}> · {p.brand}</span>}</td>
                  <td className="r num">{Quantity.formatQty(p.qtyOnHand)} {p.baseUnit}</td>
                </tr>
              ))}
              {results.length === 0 && <tr><td><Empty>Nothing matches</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="r">{directionOf(entryType) === 'out' ? 'Quantity lost' : 'Quantity'}</th>
              <th className="r">Unit cost</th><th className="r">Value</th>
              <th className="r">On hand after</th><th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const typed = Number(l.qty) || 0
              const value = Math.round(Math.abs(typed) * (Money.parseMoney(l.cost) ?? 0))
              /* The answer rather than the convention. Whatever the sign rule
                 is, a shopkeeper can see what the shelf will say afterwards
                 before pressing save. */
              const after = Quantity.addQty(
                l.product.qtyOnHand, signedQty(entryType, Quantity.fromUnits(typed)),
              )
              return (
                <tr key={l.key}>
                  <td>{l.product.name}<div className="src">on hand {Quantity.formatQty(l.product.qtyOnHand)} {l.product.baseUnit}</div></td>
                  <td className="r">
                    <input className="qty-input num" value={l.qty}
                      onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, qty: e.target.value } : x))} />
                  </td>
                  <td className="r">
                    <input className="qty-input num" placeholder="0.00" value={l.cost}
                      onChange={(e) => setLines((prev) => prev.map((x) => x.key === l.key ? { ...x, cost: e.target.value } : x))} />
                    {/* Said, not enforced. A shopkeeper holding a delivery note
                        they cannot read must still be able to record the stock;
                        a save that refuses here is a shelf that goes uncounted.

                        But a blank cost is not nothing. It falls back to the
                        last rate known for the item, which is usually close
                        enough — and where there has never been one the item
                        enters at zero, and every sale of it reads as pure
                        profit for ever with nothing saying so. Those are two
                        different sentences and only one of them is alarming. */}
                    {directionOf(entryType) === 'in' && Money.parseMoney(l.cost) === null && (
                      <div className="src warn-note">
                        {unpriced.has(l.product.id)
                          ? 'no cost ever recorded — profit on this item will read as 100%'
                          : 'no cost — the last rate paid will be assumed'}
                      </div>
                    )}
                  </td>
                  <td className="r"><Rupees value={value} /></td>
                  <td className="r num">{Quantity.formatQty(after)} {l.product.baseUnit}</td>
                  <td className="r">
                    <button className="btn ghost sm" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>✕</button>
                  </td>
                </tr>
              )
            })}
            {lines.length === 0 && <tr><td colSpan={6}><Empty>Nothing added yet</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Total value</span>
        <Rupees value={totalCost} />
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
          Unit cost is recorded per movement, so valuation stays correct later.
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={lines.length === 0} onClick={() => void submit()}>
          Post entry
        </button>
      </div>
    </div>
  )
}
