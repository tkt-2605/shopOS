import { useCallback, useEffect, useState } from 'react'
import {
  supplierSummaries, createSupplier, updateSupplier, deleteSupplier, supplierPurchases,
  type SupplierSummary, type PurchaseLine,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Modal, Field, Empty, Alert, Rupees } from '../ui/components'

interface Draft {
  supplierId: string | null
  name: string
  phone: string
  gstin: string
  address: string
  isActive: boolean
}

const EMPTY: Draft = { supplierId: null, name: '', phone: '', gstin: '', address: '', isActive: true }

export default function Suppliers() {
  const { db } = useCore()
  const user = useUser()
  const [rows, setRows] = useState<SupplierSummary[]>([])
  const [editing, setEditing] = useState<Draft | null>(null)
  const [viewing, setViewing] = useState<{ supplier: SupplierSummary; lines: PurchaseLine[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRows(await supplierSummaries(db))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  async function save() {
    if (!editing) return
    setError(null)

    const result = editing.supplierId
      ? await updateSupplier(db, {
          supplierId: editing.supplierId,
          name: editing.name, phone: editing.phone, gstin: editing.gstin,
          address: editing.address, isActive: editing.isActive, actorId: user.id,
        })
      : await createSupplier(db, {
          name: editing.name, phone: editing.phone, gstin: editing.gstin,
          address: editing.address, actorId: user.id,
        })

    if (!result.ok) {
      setError(result.code === 'NAME_TAKEN' ? 'A supplier with that name already exists.' : 'Give the supplier a name.')
      return
    }
    setEditing(null)
    await refresh()
  }

  async function remove(supplier: SupplierSummary) {
    setError(null)
    const result = await deleteSupplier(db, { supplierId: supplier.id, actorId: user.id })
    if (!result.ok) { setError(result.message); return }
    await refresh()
  }

  async function open(supplier: SupplierSummary) {
    setViewing({ supplier, lines: await supplierPurchases(db, supplier.id) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 980 }}>
      {error && <Alert>{error}</Alert>}

      <Card
        title="Suppliers"
        actions={<button className="btn primary sm" onClick={() => setEditing({ ...EMPTY })}>Add supplier</button>}
      >
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Stock In records goods against one of these, so purchase history and cost
          add up per vendor instead of scattering across three spellings of the same name.
        </div>

        <div className="card card-scroll">
          <table>
            <thead>
              <tr>
                <th>Supplier</th><th>Phone</th><th>GSTIN</th>
                <th className="r">Deliveries</th><th>Last</th><th className="r">Bought</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="pickable" onClick={() => void open(s)}>
                    {s.name}
                    {!s.isActive && <span className="badge mute" style={{ marginLeft: 7 }}>off</span>}
                  </td>
                  <td className="num">{s.phone ?? <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                  <td className="num">{s.gstin ?? <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                  <td className="r num">{s.entryCount}</td>
                  <td style={{ color: 'var(--ink-3)' }}>{s.lastPurchase ?? 'Never'}</td>
                  <td className="r">{s.purchased > 0 ? <Rupees value={s.purchased} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn ghost sm"
                      onClick={() => setEditing({
                        supplierId: s.id, name: s.name, phone: s.phone ?? '',
                        gstin: s.gstin ?? '', address: s.address ?? '', isActive: s.isActive,
                      })}
                    >
                      Edit
                    </button>
                    {s.entryCount === 0 && (
                      <button className="btn ghost sm" onClick={() => void remove(s)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7}><Empty>No suppliers yet</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {editing && (
        <Modal
          title={editing.supplierId ? `Edit ${editing.name}` : 'Add a supplier'}
          onClose={() => setEditing(null)}
          footer={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" disabled={editing.name.trim() === ''} onClick={() => void save()}>Save</button>
          </>}
        >
          <Field label="Name">
            <input className="input" id="supplier-name" autoFocus value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Sakthi Agencies" />
          </Field>
          <Field label="Phone">
            <input className="input num" id="supplier-phone" value={editing.phone}
              onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
          </Field>
          <Field label="GSTIN" hint="Needed later for input tax credit. Safe to leave blank.">
            <input className="input num" id="supplier-gstin" value={editing.gstin}
              onChange={(e) => setEditing({ ...editing, gstin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Address">
            <input className="input" id="supplier-address" value={editing.address}
              onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
          </Field>
          {editing.supplierId && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
              <input type="checkbox" checked={editing.isActive}
                onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />
              Still buying from them
            </label>
          )}
        </Modal>
      )}

      {viewing && (
        <Modal title={`${viewing.supplier.name} — deliveries`} onClose={() => setViewing(null)} wide>
          {viewing.lines.length === 0 ? (
            <Empty>Nothing has been received from this supplier</Empty>
          ) : (
            <table>
              <thead>
                <tr><th>Date</th><th>Entry</th><th>Item</th><th className="r">Qty</th><th className="r">Cost</th><th className="r">Amount</th></tr>
              </thead>
              <tbody>
                {viewing.lines.map((l, i) => (
                  <tr key={`${l.docNo}-${i}`}>
                    <td>{l.postingDate}</td>
                    <td className="num">{l.docNo}</td>
                    <td>{l.productName}</td>
                    <td className="r num">{(l.qty / 10_000).toLocaleString('en-IN')}</td>
                    <td className="r"><Rupees value={l.unitCost} /></td>
                    <td className="r"><Rupees value={l.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  )
}
