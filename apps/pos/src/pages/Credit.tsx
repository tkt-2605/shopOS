import { useCallback, useEffect, useState } from 'react'
import {
  Money, searchCustomers, customerStatement, recordPayment,
  type CustomerListItem, type CustomerStatementRow,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Empty, Alert, Rupees } from '../ui/components'

export default function Credit() {
  const { db, registerId } = useCore()
  const user = useUser()
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [open, setOpen] = useState<{ customer: CustomerListItem; rows: CustomerStatementRow[] } | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'cash' | 'upi' | 'card'>('cash')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const all = await searchCustomers(db, '', 200)
    setCustomers(all.filter((c) => c.outstanding > 0))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  async function openStatement(customer: CustomerListItem) {
    setOpen({ customer, rows: await customerStatement(db, customer.id) })
    setAmount(Money.format(customer.outstanding))
    setReference('')
    setError(null)
  }

  async function takePayment() {
    if (!open) return
    setError(null)
    const value = Money.parseMoney(amount)
    if (value === null || value <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }

    const result = await recordPayment(db, {
      customerId: open.customer.id,
      amount: value,
      method,
      reference: reference.trim(),
      registerId,
      actorId: user.id,
    })

    if (!result.ok) {
      setError('That payment could not be recorded.')
      return
    }

    setNotice(
      result.unallocated > 0
        ? `${result.docNo} — ${Money.formatWithSymbol(result.allocated)} settled, ${Money.formatWithSymbol(result.unallocated)} left over.`
        : `${result.docNo} — ${Money.formatWithSymbol(result.allocated)} settled across ${result.allocations.length} bill(s).`,
    )
    setOpen(null)
    await refresh()
  }

  const total = customers.reduce((s, c) => s + c.outstanding, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div className="stat-row">
        <div className="stat">
          <div className="label">Total outstanding</div>
          <div className="value num">{Money.formatWithSymbol(total as never)}</div>
          <div className="sub">{customers.length} customers owe money</div>
        </div>
      </div>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr><th>Customer</th><th>Phone</th><th className="r">Limit</th><th className="r">Outstanding</th><th /></tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="num">{c.phone ?? '—'}</td>
                <td className="r">{c.creditLimit > 0 ? <Rupees value={c.creditLimit} /> : <span style={{ color: 'var(--ink-3)' }}>none</span>}</td>
                <td className="r">
                  <Rupees value={c.outstanding} />
                  {c.creditLimit > 0 && c.outstanding > c.creditLimit && (
                    <span className="badge bad" style={{ marginLeft: 7 }}>over limit</span>
                  )}
                </td>
                <td className="r">
                  <button className="btn sm" onClick={() => void openStatement(c)}>Take payment</button>
                </td>
              </tr>
            ))}
            {customers.length === 0 && <tr><td colSpan={5}><Empty>Nobody owes anything</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      {open && (
        <Modal
          wide
          title={`${open.customer.name} — ${Money.formatWithSymbol(open.customer.outstanding)} outstanding`}
          onClose={() => setOpen(null)}
          footer={<>
            <button className="btn" onClick={() => setOpen(null)}>Cancel</button>
            <button className="btn primary" onClick={() => void takePayment()}>Record payment</button>
          </>}
        >
          {error && <Alert>{error}</Alert>}

          <table>
            <thead><tr><th>Bill</th><th>Date</th><th className="r">On credit</th><th className="r">Paid</th><th className="r">Still due</th></tr></thead>
            <tbody>
              {open.rows.map((r) => (
                <tr key={r.billId}>
                  <td className="num">{r.docNo}</td>
                  <td className="num">{r.postingDate}</td>
                  <td className="r"><Rupees value={r.creditTotal} /></td>
                  <td className="r"><Rupees value={r.allocated} /></td>
                  <td className="r"><Rupees value={r.outstanding} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <Field label="Amount">
              <input className="input num" id="pay-amount" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Method">
              <select className="select" id="pay-method" value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'upi' | 'card')}>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
              </select>
            </Field>
            <Field label="Reference">
              <input className="input" id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            Payment settles the oldest bills first. Anything left over stays unallocated.
          </div>
        </Modal>
      )}
    </div>
  )
}
