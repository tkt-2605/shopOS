import { useCallback, useEffect, useState } from 'react'
import {
  Money, Permissions, searchCustomers, createCustomer, updateCustomer, customerByPhone,
  type CustomerListItem, type CustomerConflict, type SaveCustomerResult,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Empty, Alert, Rupees } from '../ui/components'

/**
 * Who the shop sells to.
 *
 * The form used to write to the database itself, which is why the same person
 * could be entered three times on one phone number — there was no layer that
 * could say no, and nothing was written to the history page either. It goes
 * through `services/customers.ts` now, and the two identities a customer has
 * are both on the screen: the code, which is the shop's own reference, and the
 * phone, which is how anyone actually finds them.
 */

interface Draft {
  id: string | null
  code: string
  name: string
  phone: string
  gstin: string
  address: string
  creditLimit: string
  enforcement: 'none' | 'soft' | 'hard'
}

const BLANK: Draft = {
  id: null, code: '', name: '', phone: '', gstin: '', address: '',
  creditLimit: '0', enforcement: 'hard',
}

export default function Customers() {
  const { db, features } = useCore()
  const user = useUser()
  /* The permission grid on the Roles screen offered these and nothing read
     them, so an owner could take a cashier's right to add customers and watch
     them add one anyway. */
  const canCreate = Permissions.can(user.permissions, 'customer', 'create')
  const canWrite = Permissions.can(user.permissions, 'customer', 'write')
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<CustomerListItem[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /** Who already answers to the number being typed, said before the save. */
  const [clash, setClash] = useState<CustomerConflict | null>(null)

  const refresh = useCallback(async () => {
    setRows(await searchCustomers(db, term, 200))
  }, [db, term])

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 140)
    return () => clearTimeout(id)
  }, [refresh, term])

  /* Asked as the number is typed rather than on save, so the answer arrives
     while it is still cheap to act on — and so the way out is "open them",
     not "try a different number". */
  useEffect(() => {
    if (!draft || draft.phone.trim() === '') { setClash(null); return }
    const id = setTimeout(() => {
      void customerByPhone(db, draft.phone, draft.id).then(setClash)
    }, 200)
    return () => clearTimeout(id)
  }, [db, draft?.phone, draft?.id])

  function edit(c: CustomerListItem) {
    setProblem(null)
    setClash(null)
    setDraft({
      id: c.id, code: c.code ?? '', name: c.name, phone: c.phone ?? '',
      gstin: c.gstin ?? '', address: '',
      creditLimit: Money.format(c.creditLimit), enforcement: 'hard',
    })
  }

  async function openClash() {
    if (!clash) return
    const found = (await searchCustomers(db, clash.phone ?? clash.name, 5))
      .find((c) => c.id === clash.id)
    if (found) edit(found)
  }

  async function save() {
    if (!draft) return
    setProblem(null)

    const input = {
      name: draft.name,
      code: draft.code.trim() || null,
      phone: draft.phone.trim() || null,
      gstin: draft.gstin.trim() || null,
      address: draft.address.trim() || null,
      creditLimit: (Money.parseMoney(draft.creditLimit) ?? 0) as never,
      creditEnforcement: draft.enforcement,
    }

    const result: SaveCustomerResult = draft.id
      ? await updateCustomer(db, { actorId: user.id }, draft.id, input)
      : await createCustomer(db, { actorId: user.id }, input)

    if (!result.ok) { setProblem(describe(result)); return }
    setDraft(null)
    await refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="input" style={{ maxWidth: 340 }}
          placeholder="Search by name, phone or customer code"
          value={term} onChange={(e) => setTerm(e.target.value)} id="customer-search" />
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{rows.length} customers</span>
        <span style={{ flex: 1 }} />
        {canCreate && (
          <button className="btn primary" onClick={() => { setProblem(null); setClash(null); setDraft({ ...BLANK }) }}>
            New customer
          </button>
        )}
      </div>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Code</th>
              <th>Name</th><th>Phone</th><th>GSTIN</th>
              <th className="r">Limit</th><th className="r">Outstanding</th><th className="r">Points</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="num" style={{ color: 'var(--ink-2)' }}>{c.code ?? '—'}</td>
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
                  {canWrite && <button className="btn ghost sm" onClick={() => edit(c)}>Edit</button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8}><Empty>No customers match</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      {draft && (
        <Modal
          title={draft.id ? 'Edit customer' : 'New customer'}
          onClose={() => setDraft(null)}
          footer={<>
            <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={draft.name.trim() === '' || (features.uniquePhone && clash !== null)}
              onClick={() => void save()}
            >
              Save
            </button>
          </>}
        >
          {problem && <Alert>{problem}</Alert>}

          <Field label="Name">
            <input className="input" id="c-name" autoFocus value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Phone">
              <input className="input num" id="c-phone" value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
            <Field
              label="Customer code"
              hint={draft.id ? 'The shop’s own reference.' : 'Left blank, the next one in the series is used.'}
            >
              <input className="input num" id="c-code" value={draft.code}
                placeholder={draft.id ? '' : 'automatic'}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
            </Field>
          </div>

          {/* The number is the thing a cashier searches on, so two people sharing
              one is either a household or the same person entered twice. Which of
              those is allowed is the shop's decision; saying who already has it
              is useful either way. */}
          {clash && (
            <div className={features.uniquePhone ? 'phone-clash bad' : 'phone-clash'}>
              <div style={{ flex: 1 }}>
                <strong>{clash.name}</strong>
                {clash.code && <span className="cart-brand"> · {clash.code}</span>}
                <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginTop: 2 }}>
                  {features.uniquePhone
                    ? 'already has this number. Open them instead, or use a different number.'
                    : 'also has this number. Saving is allowed — this shop permits a shared number.'}
                </div>
              </div>
              <button className="btn sm" onClick={() => void openClash()}>Open them</button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="GSTIN">
              <input className="input num" id="c-gstin" value={draft.gstin}
                onChange={(e) => setDraft({ ...draft, gstin: e.target.value })} />
            </Field>
            <Field label="Credit limit" hint="Zero means no limit.">
              <input className="input num" id="c-limit" value={draft.creditLimit}
                onChange={(e) => setDraft({ ...draft, creditLimit: e.target.value })} />
            </Field>
          </div>

          <Field label="When over the limit">
            <select className="select" id="c-enforce" value={draft.enforcement}
              onChange={(e) => setDraft({ ...draft, enforcement: e.target.value as Draft['enforcement'] })}>
              <option value="hard">Block the sale</option>
              <option value="soft">Warn but allow</option>
              <option value="none">Ignore the limit</option>
            </select>
          </Field>

          <Field label="Address">
            <input className="input" id="c-address" value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
          </Field>
        </Modal>
      )}
    </div>
  )
}

function describe(result: Extract<SaveCustomerResult, { ok: false }>): string {
  switch (result.code) {
    case 'NAME_REQUIRED':
      return 'A customer needs a name.'
    case 'PHONE_TAKEN':
      return `${result.existing.name} already has that number. Open them instead, or turn off “one customer per phone number” in Settings.`
    case 'CODE_TAKEN':
      return `${result.existing.name} already uses the code ${result.existing.code}.`
  }
}
