import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Quantity, Tax, listStockEntries, loadStockEntry, listSuppliers,
  type StockEntryRow, type StockEntryView, type StockEntryState, type StockEntryType, type Supplier,
} from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Card, DateRangePicker, DocStatusBadge, Empty, Modal, Rupees, rangePreset, type Range } from '../../ui/components'

/*
 * Every stock entry the shop has made, in one place: deliveries, opening
 * stock, adjustments and wastage, narrowed by dates, kind, supplier, state and
 * a word -- the entry's number, the supplier's invoice, the reference or an
 * item on it (`repos/stockEntries.ts`). Opening one shows its lines.
 */

const KINDS: { id: StockEntryType | 'all'; name: string }[] = [
  { id: 'all', name: 'All' },
  { id: 'purchase', name: 'Purchases' },
  { id: 'opening', name: 'Opening stock' },
  { id: 'adjustment', name: 'Adjustments' },
  { id: 'wastage', name: 'Wastage' },
]

const KIND_NAME: Record<StockEntryType, string> = {
  purchase: 'Purchase', opening: 'Opening stock', adjustment: 'Adjustment', wastage: 'Wastage',
}

const STATES: { id: StockEntryState; name: string }[] = [
  { id: 'submitted', name: 'Posted' },
  { id: 'cancelled', name: 'Cancelled' },
  { id: 'all', name: 'All' },
]

/**
 * The Stock In page's two views: entering stock, and the entries made. The
 * entry form stays mounted while the list is shown, so lines being typed are
 * still there on coming back.
 */
export function StockInViews({ newEntry }: { newEntry: ReactNode }) {
  const [view, setView] = useState<'new' | 'past'>('new')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="segment" role="tablist" aria-label="Stock in">
        <button type="button" aria-pressed={view === 'new'} onClick={() => setView('new')}>New entry</button>
        <button type="button" aria-pressed={view === 'past'} onClick={() => setView('past')}>Past entries</button>
      </div>
      <div style={{ display: view === 'new' ? 'block' : 'none' }}>{newEntry}</div>
      {view === 'past' && <PastEntries />}
    </div>
  )
}

export function PastEntries() {
  const { db } = useCore()
  const [range, setRange] = useState<Range>(rangePreset('month'))
  const [kind, setKind] = useState<StockEntryType | 'all'>('all')
  const [state, setState] = useState<StockEntryState>('submitted')
  const [supplierId, setSupplierId] = useState('')
  const [search, setSearch] = useState('')
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [rows, setRows] = useState<StockEntryRow[]>([])
  const [open, setOpen] = useState<StockEntryView | null>(null)

  useEffect(() => { void listSuppliers(db).then(setSuppliers) }, [db])

  const refresh = useCallback(async () => {
    setRows(await listStockEntries(db, {
      from: range.from, to: range.to, entryType: kind, state, supplierId: supplierId || null, search,
    }))
  }, [db, range.from, range.to, kind, state, supplierId, search])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), search === '' ? 0 : 160)
    return () => clearTimeout(id)
  }, [refresh, search])

  const total = rows.reduce((sum, r) => sum + r.value, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1000 }}>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <DateRangePicker value={range} onChange={setRange} />
          <div className="segment">
            {KINDS.map((k) => (
              <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.name}</button>
            ))}
          </div>
          <div className="segment">
            {STATES.map((s) => (
              <button key={s.id} type="button" aria-pressed={state === s.id} onClick={() => setState(s.id)}>{s.name}</button>
            ))}
          </div>
          <select className="select" aria-label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Every supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            className="input" style={{ flex: 1, minWidth: 180 }} aria-label="Search stock entries"
            placeholder="Number, invoice, reference or item" value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </Card>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Number</th><th>Kind</th><th>Supplier or reference</th><th>Items</th>
              <th className="r" title="What it moved the stock's value by: out is below zero">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => void loadStockEntry(db, r.id).then(setOpen)} style={{ cursor: 'pointer' }}>
                <td>{r.postingDate}</td>
                <td className="num">{r.docNo}</td>
                <td>
                  {KIND_NAME[r.entryType]}
                  {r.docstatus !== 1 && <> <DocStatusBadge status={r.docstatus} /></>}
                </td>
                <td>
                  {r.supplierName ?? r.reference ?? ''}
                  {r.supplierInvoiceNo && <div className="src">invoice {r.supplierInvoiceNo}</div>}
                </td>
                <td>
                  {r.items}{r.lineCount > 3 && <span className="src"> and {r.lineCount - 3} more</span>}
                </td>
                <td className="r"><Rupees value={r.value} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6}><Empty>No stock entries for those dates</Empty></td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={5}>{rows.length === 1 ? 'One entry' : `${rows.length} entries`}</td>
                <td className="r"><Rupees value={total} /></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {open && <EntryDetail entry={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function EntryDetail({ entry, onClose }: { entry: StockEntryView; onClose: () => void }) {
  return (
    <Modal
      title={`${KIND_NAME[entry.entryType]} ${entry.docNo}`}
      wide
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12.5, marginBottom: 10 }}>
        <span><span style={{ color: 'var(--ink-3)' }}>Date </span>{entry.postingDate}</span>
        {entry.supplierName && <span><span style={{ color: 'var(--ink-3)' }}>Supplier </span>{entry.supplierName}</span>}
        {entry.supplierInvoiceNo && (
          <span>
            <span style={{ color: 'var(--ink-3)' }}>Invoice </span>{entry.supplierInvoiceNo}
            {entry.supplierInvoiceDate && ` of ${entry.supplierInvoiceDate}`}
          </span>
        )}
        {entry.reference && <span><span style={{ color: 'var(--ink-3)' }}>Reference </span>{entry.reference}</span>}
        {entry.createdBy && <span><span style={{ color: 'var(--ink-3)' }}>By </span>{entry.createdBy}</span>}
        <DocStatusBadge status={entry.docstatus} />
      </div>
      {entry.notes && <div style={{ fontSize: 12.5, marginBottom: 10 }}>{entry.notes}</div>}
      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th><th className="r">Quantity</th><th className="r">Unit cost</th>
              <th className="r">GST</th><th className="r">Value</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l, i) => (
              <tr key={`${l.productId}-${i}`}>
                <td>{l.productName}</td>
                <td className="r num">{Quantity.formatQty(l.qty)} {l.baseUnit}</td>
                <td className="r">{l.unitCost > 0 ? <Rupees value={l.unitCost} /> : <span className="src">none typed</span>}</td>
                <td className="r">
                  {l.tax > 0 ? <><Rupees value={l.tax} /><div className="src">{Tax.bpToPercent(l.taxRateBp)}%</div></> : ''}
                </td>
                <td className="r"><Rupees value={l.value} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Value to stock</td>
              <td className="r"><Rupees value={entry.value} /></td>
            </tr>
            {entry.invoiceTotal > 0 && (
              <tr>
                <td colSpan={4}>Supplier’s bill, with GST</td>
                <td className="r"><Rupees value={entry.invoiceTotal} /></td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>
    </Modal>
  )
}
