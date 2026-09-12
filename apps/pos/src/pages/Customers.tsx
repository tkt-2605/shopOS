import { useCallback, useEffect, useState } from 'react'
import { Money, searchCustomers, newId, type CustomerListItem } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Empty, Rupees } from '../ui/components'

interface Draft {
  id: string | null
  name: string
  phone: string
  gstin: string
  address: string
  creditLimit: string
  enforcement: 'none' | 'soft' | 'hard'
}

const BLANK: Draft = { id: null, name: '', phone: '', gstin: '', address: '', creditLimit: '0', enforcement: 'hard' }

export default function Customers() {
  const { db } = useCore()
  const user = useUser()
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<CustomerListItem[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)

  const refresh = useCallback(async () => {
    setRows(await searchCustomers(db, term, 200))
  }, [db, term])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 140)
    return () => clearTimeout(id)
  }, [refresh, term])

  async function save() {
    if (!draft || draft.name.trim() === '') return
    const now = new Date().toISOString()
    const limit = Money.parseMoney(draft.creditLimit) ?? 0

    if (draft.id) {
      await db.execute(
        `UPDATE customers SET name = ?, phone = ?, gstin = ?, address = ?, credit_limit = ?,
                credit_enforcement = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`,
        [draft.name.trim(), draft.phone.trim() || null, draft.gstin.trim() || null,
         draft.address.trim() || null, limit, draft.enforcement, now, user.id, draft.id],
      )
    } else {
      await db.execute(
        `INSERT INTO customers (id, name, phone, gstin, address, credit_limit, credit_enforcement, state_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '33', ?, ?)`,
        [newId(), draft.name.trim(), draft.phone.trim() || null, draft.gstin.trim() || null,
         draft.address.trim() || null, limit, draft.enforcement, now, now],
      )
    }
    setDraft(null)
    await refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Search by name or phone"
          value={term} onChange={(e) => setTerm(e.target.value)} id="customer-search" />
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{rows.length} customers</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setDraft({ ...BLANK })}>New customer</button>
      </div>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Phone</th><th>GSTIN</th>
              <th className="r">Limit</th><th className="r">Outstanding</th><th className="r">Points</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="num">{c.phone ?? '—'}</td>
                <td className="num">{c.gstin ?? '—'}</td>
                <td className="r">{c.creditLimit > 0 ? <Rupees value={c.creditLimit} /> : <span style={{ color: 'var(--ink-3)' }}>none</span>}</td>
                <td className="r">
                  {c.outstanding > 0
                    ? <Rupees value={c.outstanding} />
                    : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                </td>
                <td className="r num">{c.loyaltyPoints || '—'}</td>
                <td className="r">
                  <button className="btn ghost sm" onClick={() => setDraft({
                    id: c.id, name: c.name, phone: c.phone ?? '', gstin: c.gstin ?? '', address: '',
                    creditLimit: Money.format(c.creditLimit), enforcement: 'hard',
                  })}>Edit</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7}><Empty>No customers match</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      {draft && (
        <Modal
          title={draft.id ? 'Edit customer' : 'New customer'}
          onClose={() => setDraft(null)}
          footer={<>
            <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" disabled={draft.name.trim() === ''} onClick={() => void save()}>Save</button>
          </>}
        >
          <Field label="Name">
            <input className="input" id="c-name" autoFocus value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Phone">
              <input className="input num" id="c-phone" value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
            <Field label="GSTIN">
              <input className="input num" id="c-gstin" value={draft.gstin}
                onChange={(e) => setDraft({ ...draft, gstin: e.target.value })} />
            </Field>
            <Field label="Credit limit" hint="Zero means no limit.">
              <input className="input num" id="c-limit" value={draft.creditLimit}
                onChange={(e) => setDraft({ ...draft, creditLimit: e.target.value })} />
            </Field>
            <Field label="When over the limit">
              <select className="select" id="c-enforce" value={draft.enforcement}
                onChange={(e) => setDraft({ ...draft, enforcement: e.target.value as Draft['enforcement'] })}>
                <option value="hard">Block the sale</option>
                <option value="soft">Warn but allow</option>
                <option value="none">Ignore the limit</option>
              </select>
            </Field>
          </div>
          <Field label="Address">
            <input className="input" id="c-address" value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
          </Field>
        </Modal>
      )}
    </div>
  )
}
