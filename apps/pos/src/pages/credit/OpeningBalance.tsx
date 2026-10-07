import { useRef, useState } from 'react'
import { Money, searchCustomers, recordOpeningBalance, periodClosedMessage, type CustomerListItem } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Modal, Field, Alert } from '../../ui/components'
import { usePickList, Results } from '../../ui/PickList'
import { useSearch } from '../../ui/useSearch'

/*
 * What a customer already owed, or had paid ahead, when the shop's book moved
 * here -- entered once, dated the day the old book closed.
 */

export function OpeningBalance({
  customers, registerId, actorId, onClose, onDone,
}: {
  customers: CustomerListItem[]
  registerId: string
  actorId: string
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const { db } = useCore()
  const [term, setTerm] = useState('')
  const [chosen, setChosen] = useState<CustomerListItem | null>(null)
  const [amount, setAmount] = useState('')
  const [asOf, setAsOf] = useState('')
  const [error, setError] = useState<string | null>(null)

  const search = useSearch(term, (t) => searchCustomers(db, t, 20), { browse: true })
  const found = search.rows

  const box = useRef<HTMLInputElement>(null)

  const pick = usePickList({
    count: found.length,
    resetKey: term,
    onPick: (i) => { const c = found[i]; if (c) { setChosen(c); setError(null) } },
    enter: async () => { const [c] = await search.latest(); if (c) { setChosen(c); setError(null) } },
  })

  async function save() {
    if (!chosen) { setError('Choose a customer first.'); return }
    /* Signed on purpose. A shop moving off a paper book has both kinds of
       person in it: ones who owe it money, and ones whose money it is
       holding. Refusing the second used to mean either typing it in as a
       fake bill -- which makes the shop look as though it sold something it
       did not -- or leaving it out and charging them again for goods they
       had already paid for. */
    const value = Money.parseMoney(amount)
    if (value === null || value === 0) {
      setError('Enter an amount. Put a minus in front of it if the shop is holding their money.')
      return
    }

    const result = await recordOpeningBalance(db, {
      customerId: chosen.id,
      amount: value,
      ...(asOf.trim() ? { asOf: asOf.trim() } : {}),
      registerId,
      actorId,
    })

    if (!result.ok) {
      setError(
        result.code === 'ALREADY_SET'
          ? `${chosen.name} already has an opening balance (${result.docNo}). Cancel that first from the Bills screen.`
          : result.code === 'PERIOD_CLOSED'
            ? periodClosedMessage(result.closedThrough)
            : 'Enter an amount. Put a minus in front of it if the shop is holding their money.',
      )
      return
    }

    const size = Money.formatWithSymbol(Math.abs(value) as never)
    await onDone(
      result.direction === 'owed'
        ? `${result.docNo} — ${chosen.name} opens owing ${size}.`
        : `${result.docNo} — the shop opens holding ${size} of ${chosen.name}'s.`,
    )
  }

  return (
    <Modal
      title="What was owed before"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void save()}>Record it</button>
      </>}
    >
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
        What was in the shop’s own book before ShopOS. It goes on the khata so payments
        can settle it, and is marked so no sales report ever counts it as something the
        shop sold. One per customer.
      </div>

      {error && <Alert>{error}</Alert>}

      {chosen ? (
        <div className="phone-clash" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}>
          <div style={{ flex: 1 }}>
            <strong>{chosen.name}</strong>
            {chosen.code && <span className="cart-brand"> · {chosen.code}</span>}
          </div>
          <button className="btn sm" onClick={() => setChosen(null)}>Change</button>
        </div>
      ) : (
        <>
          <>
            <Field label="Customer">
              <input className="input" autoFocus ref={box} placeholder="Name, phone or code"
                value={term} onChange={(e) => setTerm(e.target.value)}
                onKeyDown={pick.searchKeyDown} />
            </Field>
            <Results anchor={box} open={found.length > 0}>
              <div {...pick.listProps}>
                {found.map((c, i) => (
                  <div key={c.id} style={{ padding: '7px 10px' }} {...pick.rowProps(i)}>
                    {c.name}
                    <span style={{ float: 'right', color: 'var(--ink-3)' }}>{c.code ?? c.phone ?? ''}</span>
                  </div>
                ))}
              </div>
            </Results>
          </>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Amount">
          <input className="input num" value={amount} placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="As at" hint="Blank means today.">
          <input className="input num" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </div>

      {/* Said in the form, not in a validation message afterwards. A minus
          sign nobody knows about is a feature nobody uses. */}
      <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        A plain amount means <strong>they owed the shop</strong>. Put a minus in front of it
        — <span className="num">-500</span> — if the shop was already{' '}
        <strong>holding their money</strong>, from an advance or an overpayment in the old book.
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
        {customers.length} customer{customers.length === 1 ? '' : 's'} currently owe money.
      </div>
    </Modal>
  )
}
