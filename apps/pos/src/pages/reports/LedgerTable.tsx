import { useEffect, useState } from 'react'
import { Ledger, Money, listSuppliers, searchCustomers, type GeneralLedger, type SqlDriver } from '@shopos/core'
import { Empty, Rupees } from '../../ui/components'

/**
 * What the ledger tab is narrowed to. Everything, to begin with; the
 * customers' account is every credit sale and every payment against it, and
 * one customer on top of that is their khata.
 */
export interface LedgerView {
  account: Ledger.AccountKey | ''
  /** `customer:<id>` or `supplier:<id>`, or empty for everybody. */
  party: string
}

export const EVERYTHING: LedgerView = { account: '', party: '' }

export function ledgerFilter(view: LedgerView): {
  account: Ledger.AccountKey | null
  party: { type: 'customer' | 'supplier'; id: string } | null
} {
  const [type, id] = view.party.split(':')
  return {
    account: view.account || null,
    party: (type === 'customer' || type === 'supplier') && id ? { type, id } : null,
  }
}

/** A ledger runs across months and years, so its dates carry the year. */
export function ledgerDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** A balance read the way a ledger is: Dr when debits lead, Cr when credits do. */
export function drCr(amount: number): string {
  if (amount === 0) return Money.format(0 as Money.Money)
  return `${Money.format(Math.abs(amount) as Money.Money)} ${amount > 0 ? 'Dr' : 'Cr'}`
}

export function LedgerFilters({ db, view, onChange }: {
  db: SqlDriver
  view: LedgerView
  onChange: (view: LedgerView) => void
}) {
  const [parties, setParties] = useState<{ key: string; name: string }[]>([])
  useEffect(() => {
    let live = true
    void Promise.all([searchCustomers(db, '', 1000), listSuppliers(db, true)]).then(([customers, suppliers]) => {
      if (!live) return
      setParties([
        ...customers.map((c) => ({ key: `customer:${c.id}`, name: `${c.name} · customer` })),
        ...suppliers.map((s) => ({ key: `supplier:${s.id}`, name: `${s.name} · supplier` })),
      ].sort((a, b) => a.name.localeCompare(b.name)))
    })
    return () => { live = false }
  }, [db])

  const accounts = Object.entries(Ledger.ACCOUNTS) as [Ledger.AccountKey, { name: string }][]
  return (
    <div className="filter-bar">
      <select
        className="select" style={{ width: 240 }} aria-label="Account" value={view.account}
        onChange={(e) => onChange({ ...view, account: e.target.value as LedgerView['account'] })}
      >
        <option value="">Every account</option>
        {accounts.map(([key, a]) => <option key={key} value={key}>{a.name}</option>)}
      </select>
      <select
        className="select" style={{ width: 260 }} aria-label="Customer or supplier" value={view.party}
        onChange={(e) => onChange({ ...view, party: e.target.value })}
      >
        <option value="">Every customer and supplier</option>
        {parties.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
      </select>
      <button className="btn sm" onClick={() => onChange({ account: 'debtors', party: '' })}>
        All customer credit and payments
      </button>
      {(view.account || view.party) && <button className="btn ghost sm" onClick={() => onChange(EVERYTHING)}>Clear</button>}
    </div>
  )
}

export function LedgerTable({ ledger }: { ledger: GeneralLedger }) {
  if (ledger.rows.length === 0 && ledger.opening === 0) return <Empty>Nothing was posted in this range</Empty>
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th><th>Document</th><th>Account</th><th>Customer or supplier</th>
          <th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colSpan={6} className="src">Brought forward</td>
          <td className="r num">{drCr(ledger.opening)}</td>
        </tr>
        {ledger.rows.map((r) => (
          <tr key={r.id}>
            <td className="num">{ledgerDate(r.postingDate)}</td>
            <td>
              {r.voucherLabel}
              {r.docNo && <span className="num"> {r.docNo}</span>}
              {r.isReversal && <span className="badge" style={{ marginLeft: 6 }}>cancelled</span>}
            </td>
            <td>{r.accountName}</td>
            <td>{r.partyName ?? ''}</td>
            <td className="r">{r.debit > 0 ? <Rupees value={r.debit} /> : ''}</td>
            <td className="r">{r.credit > 0 ? <Rupees value={r.credit} /> : ''}</td>
            <td className="r num">{drCr(r.balance)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th colSpan={4}>
            {ledger.truncated ? `Showing the first ${ledger.rows.length} entries — narrow the range to see the rest. Totals count them all.` : 'Total'}
          </th>
          <th className="r"><Rupees value={ledger.debit} /></th>
          <th className="r"><Rupees value={ledger.credit} /></th>
          <th className="r num">{drCr(ledger.closing)}</th>
        </tr>
      </tfoot>
    </table>
  )
}
