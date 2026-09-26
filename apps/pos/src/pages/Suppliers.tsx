import { useCallback, useEffect, useState } from 'react'
import {
  Permissions,
  supplierSummaries, createSupplier, updateSupplier, archiveSupplier, restoreSupplier,
  setSupplierOpening, Money,
  type SupplierOrder,
  type SupplierSummary,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { SupplierFile } from '../ui/SupplierFile'
import { Card, Modal, Field, Empty, Alert, Rupees } from '../ui/components'
import { SupplierWorth } from '../ui/SupplierWorth'
import { useConfirm } from '../ui/useConfirm'
import { useShopChanged } from '../core/useShopChanged'

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
  const [confirmUi, ask] = useConfirm()
  const canCreate = Permissions.can(user.permissions, 'supplier', 'create')
  const canWrite = Permissions.can(user.permissions, 'supplier', 'write')
  const canDelete = Permissions.can(user.permissions, 'supplier', 'delete')
  const [rows, setRows] = useState<SupplierSummary[]>([])
  const [editing, setEditing] = useState<Draft | null>(null)
  /* The supplier, not a snapshot of their lines: the panel reads both the
     per-item summary and the deliveries itself, and two loaders for one
     screen is one of them going stale. */
  const [viewing, setViewing] = useState<SupplierSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function saveOpening() {
    if (!opening) return
    const value = Money.parseMoney(openingAmount.trim() === '' ? '0' : openingAmount)
    if (value === null) { setError('That amount is not a number.'); return }

    const result = await setSupplierOpening(db, { actorId: user.id }, {
      supplierId: opening.id,
      amount: value,
      asOf: openingAsOf.trim() === '' ? null : openingAsOf.trim(),
    })
    if (!result.ok) { setError('That supplier is no longer here.'); return }

    setError(null)
    setOpening(null)
    await refresh()
  }
  const [showArchived, setShowArchived] = useState(false)
  /* In the query, not over the rows: `owed` and `bought` are both computed
     columns, and sorting them here would mean the screen recomputing money
     the database already worked out. */
  const [order, setOrder] = useState<SupplierOrder>('name')
  /** The supplier whose carried-over balance is being set, and the typed figure. */
  const [opening, setOpening] = useState<SupplierSummary | null>(null)
  const [openingAmount, setOpeningAmount] = useState('')
  const [openingAsOf, setOpeningAsOf] = useState('')

  const refresh = useCallback(async () => {
    setRows(await supplierSummaries(db, { includeArchived: showArchived, order }))
  }, [db, showArchived, order])

  useEffect(() => { void refresh() }, [refresh])
  // And again whenever the other till sends something this list shows.
  useShopChanged(refresh)

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

  /**
   * Off the list, and back onto it.
   *
   * This used to be Delete, and it was offered only when nothing had ever been
   * bought from them -- because for any other supplier it refused with "Switch
   * it off instead", pointing at a thing that did not exist. It archives now,
   * for every supplier, and the row stays: it is what gives received stock its
   * cost, and a shop with a stock entry from nobody cannot explain its own
   * margins.
   */
  async function archive(supplier: SupplierSummary) {
    setError(null)

    if (supplier.archived) {
      await restoreSupplier(db, { supplierId: supplier.id, actorId: user.id })
      await refresh()
      return
    }

    if (!(await ask(
      `Take ${supplier.name} off the list?\n\n`
      + 'Nothing is deleted: what was bought from them stays on every stock '
      + 'entry and keeps its cost. They can be brought back from this screen.',
    ))) return

    await archiveSupplier(db, { supplierId: supplier.id, actorId: user.id })
    await refresh()
  }


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 980 }}>
      {confirmUi}
      {error && <Alert>{error}</Alert>}

      <Card
        title="Suppliers"
        actions={canCreate
          ? <button className="btn primary sm" onClick={() => setEditing({ ...EMPTY })}>Add supplier</button>
          : undefined}
      >
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 13 }}>
          Stock In records goods against one of these, so purchase history and cost
          add up per vendor instead of scattering across three spellings of the same name.
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <select
            className="input" style={{ maxWidth: 190 }} value={order}
            aria-label="Sort the list"
            onChange={(e) => setOrder(e.target.value as SupplierOrder)}
          >
            <option value="name">By name</option>
            <option value="owed">Most owed first</option>
            <option value="bought">Most bought from</option>
            <option value="quietest">Quietest first</option>
          </select>

          <label style={{
            fontSize: 12.5, color: 'var(--ink-2)', display: 'flex', gap: 5, alignItems: 'center',
          }}>
            <input
              type="checkbox" checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show the ones taken off the list
          </label>

          <span style={{ flex: 1 }} />
          {canWrite && <SupplierFile onDone={refresh} />}
        </div>

        <div className="card card-scroll">
          <table>
            <thead>
              <tr>
                <th>Supplier</th><th>Phone</th><th>GSTIN</th>
                <th className="r">Deliveries</th><th>Last</th><th className="r">Bought</th>
                <th className="r">Carried over</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    {/* A button rather than a clickable cell: the row already
                        has Edit and Delete in the tab order, and the name was
                        the one thing in it the keyboard could not reach. */}
                    <button className="cell-btn" onClick={() => setViewing(s)}>{s.name}</button>
                    {!s.isActive && <span className="badge mute" style={{ marginLeft: 7 }}>off</span>}
                    {/* Two different things, and the badges say which: "off" is
                        not buying from them at the moment, "removed" is off the
                        list entirely. */}
                    {s.archived && <span className="badge" style={{ marginLeft: 7 }}>removed</span>}
                  </td>
                  <td className="num">{s.phone ?? <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                  <td className="num">{s.gstin ?? <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                  <td className="r num">{s.entryCount}</td>
                  <td style={{ color: 'var(--ink-3)' }}>{s.lastPurchase ?? 'Never'}</td>
                  <td className="r">{s.purchased > 0 ? <Rupees value={s.purchased} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
                  {/* Never asked and answered-zero read the same in a figure,
                      so the dash is for the first and a plain 0 for the
                      second. A shop that has said "we owed them nothing" has
                      said something. */}
                  <td className="r" title={s.openingAsOf ? `As at ${s.openingAsOf}` : 'Nobody has said'}>
                    {s.openingAsOf === null
                      ? <span style={{ color: 'var(--ink-3)' }}>—</span>
                      : <Rupees value={s.openingBalance} />}
                  </td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    {canWrite && (
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          setOpening(s)
                          setOpeningAmount(s.openingAsOf === null ? '' : Money.format(s.openingBalance))
                          setOpeningAsOf(s.openingAsOf ?? '')
                        }}
                      >
                        Carried over
                      </button>
                    )}
                    {canWrite && (
                      <button
                        className="btn ghost sm"
                        onClick={() => setEditing({
                          supplierId: s.id, name: s.name, phone: s.phone ?? '',
                          gstin: s.gstin ?? '', address: s.address ?? '', isActive: s.isActive,
                        })}
                      >
                        Edit
                      </button>
                    )}
                    {canDelete && (
                      <button className="btn ghost sm" onClick={() => void archive(s)}>
                        {s.archived ? 'Bring back' : 'Remove'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8}><Empty>No suppliers yet</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {opening && (
        <Modal
          title={`What the shop owed ${opening.name}`}
          onClose={() => setOpening(null)}
          footer={<>
            <button className="btn" onClick={() => setOpening(null)}>Cancel</button>
            <button className="btn primary" onClick={() => void saveOpening()}>Record it</button>
          </>}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Amount">
              <input className="input num" value={openingAmount} placeholder="0.00"
                onChange={(e) => setOpeningAmount(e.target.value)} />
            </Field>
            <Field label="As at">
              <input className="input num" type="date" value={openingAsOf}
                onChange={(e) => setOpeningAsOf(e.target.value)} />
            </Field>
          </div>

          {/* Said in the form rather than in an error afterwards. A minus sign
              nobody knows about is a feature nobody uses. */}
          <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
            A plain amount means <strong>the shop owed them</strong> when the books moved.
            Put a minus in front of it — <span className="num">-3000</span> — if they were
            already holding the shop's money, from an advance paid or an overpayment in the
            old book.
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            This is a figure you can correct, not a document. Purchases will build on it.
          </div>
        </Modal>
      )}

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
        <SupplierWorth
          supplierId={viewing.id}
          name={viewing.name}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
