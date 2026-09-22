import { useCallback, useEffect, useState } from 'react'
import {
  Money, Permissions, searchCustomers, createCustomer, updateCustomer, customerByPhone,
  type CustomerOrder,
  archiveCustomer, restoreCustomer,
  loadCustomer, STATES, stateName, stateFromGstin,
  type CustomerListItem, type CustomerConflict, type SaveCustomerResult,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Empty, Alert, Rupees } from '../ui/components'
import { CustomerWorth } from '../ui/CustomerWorth'
import { useConfirm } from '../ui/useConfirm'
import { useShopChanged } from '../core/useShopChanged'
import { CustomerFile } from '../ui/CatalogueFile'

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
  /** Blank means "work it out" — from the GSTIN, or the shop's own state. */
  stateCode: string
  creditLimit: string
  enforcement: 'none' | 'soft' | 'hard'
}

const BLANK: Draft = {
  id: null, code: '', name: '', phone: '', gstin: '', address: '', stateCode: '',
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
  /* The row, so the panel can open on the name that was clicked. It
     reads everything else itself. */
  const [worth, setWorth] = useState<CustomerListItem | null>(null)
  const [confirmUi, ask] = useConfirm()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /* Decided by the database, not by sorting the rows: this list stops at two
     hundred names, so sorting what came back sorts an arbitrary two hundred
     of a larger book. */
  const [order, setOrder] = useState<CustomerOrder>('name')
  /** Who already answers to the number being typed, said before the save. */
  const [clash, setClash] = useState<CustomerConflict | null>(null)
  /** Off by default: an archived customer is one the shop has finished with. */
  const [showArchived, setShowArchived] = useState(false)

  const refresh = useCallback(async () => {
    setRows(await searchCustomers(db, term, 200, { includeArchived: showArchived, order }))
  }, [db, term, showArchived, order])

  /**
   * A customer who has stopped coming.
   *
   * `customers.deleted_at` has been filtered by every search since they were
   * written and nothing ever set it, so a list that had filled up with one-off
   * walk-ins, duplicates and people who moved away could not be tidied at all.
   *
   * Archived, never deleted: every bill they were issued names them, their
   * points are theirs and the khata is a record of money that changed hands.
   * All it does is take them out of the searches.
   */
  async function archive(c: CustomerListItem) {
    setProblem(null)

    if (c.archived) {
      await restoreCustomer(db, { actorId: user.id }, c.id)
      await refresh()
      return
    }

    if (!(await ask(
      `Archive ${c.name}?

`
      + 'They stop appearing when searching here and at the counter. Nothing is '
      + 'deleted — their bills, their khata and their points are all kept, and '
      + 'they can be brought back from this screen.',
    ))) return

    const result = await archiveCustomer(db, { actorId: user.id }, c.id)
    if (!result.ok) {
      /* Hiding somebody who still owes money hides the debt, and a balance
         nobody can find is one the shop has written off without deciding to. */
      setProblem(
        `${c.name} still owes ${Money.formatWithSymbol(result.outstanding)}. `
        + 'Settle the khata first, or write it off on purpose — archiving them '
        + 'now would hide the money owed along with them.',
      )
      return
    }
    await refresh()
  }

  useEffect(() => {
    const id = setTimeout(() => void refresh(), term === '' ? 0 : 140)
    return () => clearTimeout(id)
  }, [refresh, term])
  // And again when the other till adds or edits one.
  useShopChanged(refresh)

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

  /**
   * The whole customer, not the row from the list.
   *
   * This used to fill the form from `CustomerListItem`, which carries neither
   * the address, the state nor the credit enforcement -- so it defaulted the
   * three it could not see and then wrote all of them back on save. Editing a
   * phone number erased the address and moved a customer who had been set to
   * `none` onto hard credit enforcement, which stops them buying at the
   * counter. Nothing on the screen said so.
   */
  async function edit(c: CustomerListItem) {
    setProblem(null)
    setClash(null)
    const full = await loadCustomer(db, c.id)
    if (!full) { setProblem('That customer could not be opened.'); return }
    setDraft({
      id: full.id, code: full.code ?? '', name: full.name, phone: full.phone ?? '',
      gstin: full.gstin ?? '', address: full.address ?? '',
      stateCode: full.stateCode ?? '',
      creditLimit: Money.format(full.creditLimit), enforcement: full.creditEnforcement,
    })
  }

  async function openClash() {
    if (!clash) return
    const found = (await searchCustomers(db, clash.phone ?? clash.name, 5))
      .find((c) => c.id === clash.id)
    if (found) await edit(found)
  }

  /**
   * The state the GSTIN settles, if it settles one.
   *
   * Shown instead of the chosen value rather than written into the draft: a
   * half-typed GSTIN would otherwise keep overwriting a state somebody had
   * picked, and the service decides the final answer anyway.
   */
  const fromGstin = stateFromGstin(draft?.gstin ?? null)

  async function save() {
    if (!draft) return
    setProblem(null)

    const input = {
      name: draft.name,
      code: draft.code.trim() || null,
      phone: draft.phone.trim() || null,
      gstin: draft.gstin.trim() || null,
      address: draft.address.trim() || null,
      stateCode: draft.stateCode || null,
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
      {confirmUi}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="input" style={{ maxWidth: 340 }}
          placeholder="Search by name, phone or customer code"
          value={term} onChange={(e) => setTerm(e.target.value)} id="customer-search" />
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{rows.length} customers</span>
        <label style={{ fontSize: 12.5, color: 'var(--ink-2)', display: 'flex', gap: 5, alignItems: 'center' }}>
          <input
            type="checkbox" checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        <select
          className="input" style={{ maxWidth: 180 }} value={order}
          aria-label="Sort the list"
          onChange={(e) => setOrder(e.target.value as CustomerOrder)}
        >
          <option value="name">By name</option>
          <option value="owing">Most owed first</option>
          <option value="oldest">Quietest first</option>
        </select>
        <span style={{ flex: 1 }} />
        {canWrite && <CustomerFile onDone={refresh} />}
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
                <td>
                  {/* The name is the way in. A customer's worth to the shop
                     is a question asked while looking at their name, not
                     one reached from a menu somewhere else. */}
                  <button className="cell-btn" onClick={() => setWorth(c)}>{c.name}</button>
                  {c.archived && <span className="badge" style={{ marginLeft: 6 }}>archived</span>}
                </td>
                <td className="num">{c.phone ?? '—'}</td>
                <td className="num">{c.gstin ?? '—'}</td>
                <td className="r">{c.creditLimit > 0 ? <Rupees value={c.creditLimit} /> : <span style={{ color: 'var(--ink-3)' }}>none</span>}</td>
                <td className="r">
                  {c.outstanding > 0
                    ? <Rupees value={c.outstanding} />
                    : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                </td>
                <td className="r num">{c.loyaltyPoints || '—'}</td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  {canWrite && <button className="btn ghost sm" onClick={() => void edit(c)}>Edit</button>}
                  {canWrite && (
                    <button className="btn ghost sm" onClick={() => void archive(c)}>
                      {c.archived ? 'Bring back' : 'Archive'}
                    </button>
                  )}
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
                onChange={(e) => setDraft({ ...draft, gstin: e.target.value.toUpperCase() })} />
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

          <Field
            label="State"
            hint={
              fromGstin
                ? `Taken from the GSTIN: ${stateName(fromGstin) ?? fromGstin}.`
                : 'Decides whether a bill charges CGST and SGST or IGST. Left blank, the shop’s own state is used.'
            }
          >
            <select
              className="input"
              id="c-state"
              value={fromGstin ?? draft.stateCode}
              /* A GSTIN settles it: the number is the registered fact, and a
                 form that let somebody disagree with it would only produce a
                 refusal on save. */
              disabled={fromGstin !== null}
              onChange={(e) => setDraft({ ...draft, stateCode: e.target.value })}
            >
              <option value="">Same as the shop</option>
              {STATES.map((st) => (
                <option key={st.code} value={st.code}>{st.code} — {st.name}</option>
              ))}
            </select>
          </Field>
        </Modal>
      )}
      {worth && (
        <CustomerWorth
          customerId={worth.id}
          name={worth.name}
          code={worth.code}
          onClose={() => setWorth(null)}
        />
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
    case 'BAD_GSTIN':
      // Said as a shape rather than as "invalid", which tells nobody what to do.
      return 'That is not a GSTIN. They are 15 characters, like 33AAACS1234F1Z5.'
    case 'UNKNOWN_STATE':
      return 'That is not a state code. Pick one from the list.'
    case 'GSTIN_STATE_MISMATCH':
      return `The GSTIN is registered in ${stateName(result.gstinState) ?? result.gstinState}`
        + ` but the state says ${stateName(result.chosenState) ?? result.chosenState}.`
        + ' The GSTIN is the registered fact, so clear the state or correct the number.'
  }
}
