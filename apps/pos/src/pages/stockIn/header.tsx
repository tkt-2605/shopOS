import { useState } from 'react'
import { createSupplier, type StockEntryType, type Supplier } from '@shopos/core'
import { useCore, useUser } from '../../core/CoreProvider'
import { Field, Modal, Alert } from '../../ui/components'

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

/** The kind of entry. Locked while the entry is an order's delivery, which is a purchase. */
export function EntryKindField({ value, locked, onChange }: {
  value: StockEntryType
  locked: boolean
  onChange: (kind: StockEntryType) => void
}) {
  return (
    <Field label="Kind of entry" hint={TYPES.find((t) => t.id === value)?.note}>
      <select className="select" id="entry-type" value={value} disabled={locked}
        onChange={(e) => onChange(e.target.value as StockEntryType)}>
        {TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </Field>
  )
}

/** The supplier, and a way to add one without leaving the entry. Locked to the order's while receiving one. */
export function SupplierField({ suppliers, value, locked, purchase, onChange, onAdded }: {
  suppliers: Supplier[]
  value: string
  locked: boolean
  purchase: boolean
  onChange: (supplierId: string) => void
  onAdded: (supplierId: string) => void
}) {
  const [adding, setAdding] = useState(false)
  return (
    <Field
      label="Supplier"
      hint={purchase ? 'Links this delivery to a vendor, so cost history adds up per supplier.' : undefined}
    >
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          className="select" id="supplier" style={{ flex: 1, minWidth: 0 }} disabled={locked}
          value={value} onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Not recorded</option>
          {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <button className="btn sm" disabled={locked} onClick={() => setAdding(true)} title="Add a supplier">+</button>
      </div>
      {adding && (
        <AddSupplier onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); onAdded(id) }} />
      )}
    </Field>
  )
}

/**
 * A supplier added without leaving the entry: the delivery is on the counter
 * and the person is holding its bill. Only the name; the rest is filled in on
 * the Suppliers screen when there is time.
 */
function AddSupplier({ onClose, onAdded }: {
  onClose: () => void
  onAdded: (supplierId: string) => void
}) {
  const { db } = useCore()
  const user = useUser()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function add() {
    setError(null)
    const result = await createSupplier(db, { name, actorId: user.id })
    if (!result.ok) {
      setError(result.code === 'NAME_TAKEN' ? 'That supplier already exists — pick it from the list.' : 'Give the supplier a name.')
      return
    }
    onAdded(result.supplierId)
  }

  return (
    <Modal
      title="Add a supplier"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={name.trim() === ''} onClick={() => void add()}>Add</button>
      </>}
    >
      {error && <Alert>{error}</Alert>}
      <Field label="Name" hint="Phone, GSTIN and the rest can be filled in later on the Suppliers screen.">
        <input className="input" id="new-supplier" autoFocus value={name}
          onChange={(e) => setName(e.target.value)} placeholder="Sakthi Agencies" />
      </Field>
    </Modal>
  )
}
