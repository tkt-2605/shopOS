import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Money, searchCustomers, customerStatement, customerAccount, recordPayment,
  listCustomerPayments, cancelPayment, writeOff, recordOpeningBalance, businessDate, addDays,
  type CustomerListItem, type CustomerStatementRow, type CustomerPayment, type CustomerAccount,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Field, Empty, Alert, Rupees, Stat } from '../ui/components'
import { usePickList } from '../ui/PickList'
import { printStatement } from '../core/print'
import { statementPdf } from '../core/pdf'

/**
 * The khata.
 *
 * This screen could take a payment and show a balance, and that was all — which
 * left the four things a shopkeeper actually does with credit unreachable, even
 * though three of them were already built into the engine and called by nothing:
 * settling a chosen bill rather than the oldest, undoing a receipt entered
 * against the wrong customer, and giving up on a debt that is not worth chasing.
 *
 * Laid out around the question being asked. The list is a collection round —
 * who owes, how long it has been, worst first. The panel is one customer's
 * account, where everything that can be done to it lives together rather than
 * behind separate buttons on separate screens.
 */

type Tab = 'due' | 'paid' | 'statement'

interface Account {
  customer: CustomerListItem
  bills: CustomerStatementRow[]
  payments: CustomerPayment[]
}

/** How the money is coming in, or that it is not coming in at all. */
type Settle = 'cash' | 'upi' | 'card' | 'writeoff'

export default function Credit() {
  const { db, registerId } = useCore()
  const user = useUser()
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState<Account | null>(null)
  /* A statement is not only for people who owe. A customer who has paid up still
     wants the page — often more so, because it is the proof they have. */
  const [who, setWho] = useState<'owing' | 'everyone'>('owing')
  const [opening, setOpening] = useState<CustomerListItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [everyone, setEveryone] = useState<CustomerListItem[]>([])

  const refresh = useCallback(async () => {
    const all = await searchCustomers(db, '', 500)
    setEveryone(all)
    setCustomers(all.filter((c) => c.outstanding > 0))
  }, [db])

  useEffect(() => { void refresh() }, [refresh])

  const shown = useMemo(() => {
    const list = who === 'owing' ? customers : everyone
    const t = term.trim().toLowerCase()
    if (t === '') return list
    return list.filter((c) =>
      c.name.toLowerCase().includes(t)
      || (c.phone ?? '').includes(t)
      || (c.code ?? '').toLowerCase().includes(t))
  }, [customers, everyone, who, term])

  const load = useCallback(async (customer: CustomerListItem) => {
    const [bills, payments] = await Promise.all([
      customerStatement(db, customer.id),
      listCustomerPayments(db, customer.id),
    ])
    setOpen({ customer, bills, payments })
  }, [db])

  async function reload() {
    if (!open) return
    const fresh = (await searchCustomers(db, open.customer.phone ?? open.customer.name, 20))
      .find((c) => c.id === open.customer.id)
    await load(fresh ?? open.customer)
    await refresh()
  }

  function say(message: string) {
    setNotice(message)
    setTimeout(() => setNotice(null), 9000)
  }

  const pick = usePickList({
    count: shown.length,
    as: 'grid',
    resetKey: term,
    onPick: (i) => { const c = shown[i]; if (c) void load(c) },
  })

  /* Simple analytics: the three numbers that decide whether today is a
     collection day, and the one customer to start with. */
  const total = shown.reduce((s, c) => s + c.outstanding, 0)
  const worst = shown.reduce<CustomerListItem | null>(
    (w, c) => (w === null || c.outstanding > w.outstanding ? c : w), null,
  )
  const overLimit = shown.filter((c) => c.creditLimit > 0 && c.outstanding > c.creditLimit).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div className="stat-row">
        <Stat
          label="Total outstanding"
          value={<span className="num">{Money.formatWithSymbol(total as never)}</span>}
          sub={`${shown.length} ${shown.length === 1 ? 'customer owes' : 'customers owe'} money`}
        />
        <Stat
          label="Owes the most"
          value={worst ? worst.name : '—'}
          sub={worst ? Money.formatWithSymbol(worst.outstanding) : 'Nothing outstanding'}
        />
        <Stat
          label="Over their limit"
          value={<span className="num">{overLimit}</span>}
          sub={overLimit === 0 ? 'Everyone is within it' : 'Selling on credit is blocked for these'}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div className="segment">
          <button className={who === 'owing' ? 'on' : ''} onClick={() => setWho('owing')}>
            Owing ({customers.length})
          </button>
          <button className={who === 'everyone' ? 'on' : ''} onClick={() => setWho('everyone')}>
            Everyone ({everyone.length})
          </button>
        </div>
        <input className="input" style={{ maxWidth: 340 }}
          placeholder="Search by name, phone or customer code"
          value={term} onChange={(e) => setTerm(e.target.value)} id="credit-search" />
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setOpening(everyone[0] ?? null)} disabled={everyone.length === 0}>
          Opening balance
        </button>
      </div>

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Code</th>
              <th>Customer</th><th>Phone</th>
              <th className="r">Limit</th><th className="r">Outstanding</th><th />
            </tr>
          </thead>
          <tbody {...pick.listProps}>
            {shown.map((c, i) => (
              <tr key={c.id} {...pick.rowProps(i)}>
                <td className="num" style={{ color: 'var(--ink-2)' }}>{c.code ?? '—'}</td>
                <td>{c.name}</td>
                <td className="num">{c.phone ?? '—'}</td>
                <td className="r">
                  {c.creditLimit > 0
                    ? <Rupees value={c.creditLimit} />
                    : <span style={{ color: 'var(--ink-3)' }}>none</span>}
                </td>
                <td className="r">
                  <Rupees value={c.outstanding} />
                  {c.creditLimit > 0 && c.outstanding > c.creditLimit && (
                    <span className="badge bad" style={{ marginLeft: 7 }}>over limit</span>
                  )}
                </td>
                <td className="r">
                  <button className="btn sm" onClick={() => void load(c)}>Open account</button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <Empty>
                    {term ? 'Nobody matches' : who === 'owing' ? 'Nobody owes anything' : 'No customers yet'}
                  </Empty>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <AccountPanel
          account={open}
          registerId={registerId}
          actorId={user.id}
          onClose={() => setOpen(null)}
          onChanged={async (message) => { say(message); await reload() }}
        />
      )}

      {opening && (
        <OpeningBalance
          customers={everyone}
          registerId={registerId}
          actorId={user.id}
          onClose={() => setOpening(null)}
          onDone={async (message) => { setOpening(null); say(message); await refresh() }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------- one account --- */

function AccountPanel({
  account, registerId, actorId, onClose, onChanged,
}: {
  account: Account
  registerId: string
  actorId: string
  onClose: () => void
  onChanged: (message: string) => Promise<void>
}) {
  const { db } = useCore()
  /* A customer who has paid up is here for the statement, not to be charged
     again, so that is the tab that opens. */
  const [tab, setTab] = useState<Tab>(account.customer.outstanding > 0 ? 'due' : 'statement')
  const [settle, setSettle] = useState<Settle>('cash')
  const [amount, setAmount] = useState(Money.format(account.customer.outstanding))
  const [reference, setReference] = useState('')
  /** Null means oldest first, which is what clearing khata ordinarily means. */
  const [targetBill, setTargetBill] = useState<string | null>(null)
  /* The statement window. Blank means the whole account, which is what an
     argument over a balance usually needs; a month is what a regular customer
     gets handed. */
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [statement, setStatement] = useState<CustomerAccount | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const due = account.bills.reduce((s, b) => s + b.outstanding, 0)

  /* Fetched rather than derived from what is already on screen: the statement
     includes cash purchases and returns, which the open-bills list by
     definition does not have. */
  useEffect(() => {
    void customerAccount(db, account.customer.id, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }).then(setStatement)
  }, [db, account.customer.id, account.payments.length, account.bills.length, from, to])

  /* Aiming a payment at one bill is the difference between a khata and a
     ledger: a customer settling last Tuesday's bill is not settling the
     oldest one, and telling them it went elsewhere is how arguments start. */
  function aim(row: CustomerStatementRow | null) {
    setTargetBill(row?.billId ?? null)
    setAmount(Money.format(row ? row.outstanding : (due as never)))
    setError(null)
  }

  async function apply() {
    if (busy) return
    const value = Money.parseMoney(amount)
    if (value === null || value <= 0) { setError('Enter an amount greater than zero.'); return }
    setBusy(true)
    setError(null)

    const result = settle === 'writeoff'
      ? await writeOff(db, {
        customerId: account.customer.id,
        ...(targetBill ? { billId: targetBill } : {}),
        amount: value,
        reason: reference.trim() || 'Not worth chasing',
        actorId,
      })
      : await recordPayment(db, {
        customerId: account.customer.id,
        amount: value,
        method: settle,
        reference: reference.trim(),
        ...(targetBill ? { allocations: [{ billId: targetBill, amount: value }] } : {}),
        registerId,
        actorId,
      })

    setBusy(false)
    if (!result.ok) { setError(describePayment(result)); return }

    const what = settle === 'writeoff' ? 'written off' : 'settled'
    await onChanged(
      result.unallocated > 0
        ? `${result.docNo} — ${Money.formatWithSymbol(result.allocated)} ${what}, ${Money.formatWithSymbol(result.unallocated)} left over.`
        : `${result.docNo} — ${Money.formatWithSymbol(result.allocated)} ${what}.`,
    )
  }

  async function undo(payment: CustomerPayment) {
    const back = payment.allocatedTo.length > 0
      ? ` ${payment.allocatedTo.map((a) => a.docNo).join(', ')} will go back on the khata.`
      : ''
    if (!window.confirm(`Cancel ${payment.docNo} for ${Money.formatWithSymbol(payment.amount)}?${back}`)) return
    await cancelPayment(db, { paymentId: payment.paymentId, reason: 'Cancelled from the credit screen', actorId })
    await onChanged(`${payment.docNo} cancelled.`)
  }

  const window_ = () => ({ ...(from ? { from } : {}), ...(to ? { to } : {}) })

  async function print() {
    const result = await printStatement(db, account.customer.id, window_())
    if (!result.ok) setError(result.message)
  }

  /* For the customer who is not standing at the counter — the one who wants it
     on WhatsApp, or the one arguing about a balance by phone. */
  async function savePdf() {
    setError(null)
    const result = await statementPdf(db, account.customer.id, window_())
    if (!result.ok) { setError(result.message); return }
    await onChanged(`Statement saved to ${result.path}`)
  }

  return (
    <Modal
      wide
      title={`${account.customer.name}${account.customer.code ? ` · ${account.customer.code}` : ''}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={() => void print()}>Print statement</button>
        <button className="btn" onClick={() => void savePdf()}>Statement as PDF</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" disabled={busy} onClick={() => void apply()}>
          {busy ? 'Working…' : settle === 'writeoff' ? 'Write it off' : 'Record payment'}
        </button>
      </>}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 24, fontWeight: 700 }}>
          <Rupees value={due as never} />
        </span>
        <span style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
          outstanding across {account.bills.length} bill{account.bills.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="segment">
        <button className={tab === 'due' ? 'on' : ''} onClick={() => setTab('due')}>What is owed</button>
        <button className={tab === 'paid' ? 'on' : ''} onClick={() => setTab('paid')}>
          Received ({account.payments.length})
        </button>
        <button className={tab === 'statement' ? 'on' : ''} onClick={() => setTab('statement')}>
          Statement
        </button>
      </div>

      {tab === 'due' && (
        <table>
          <thead>
            <tr>
              <th>Bill</th><th>Date</th>
              <th className="r">On credit</th><th className="r">Paid</th><th className="r">Still due</th><th />
            </tr>
          </thead>
          <tbody>
            {account.bills.map((r) => (
              <tr key={r.billId} style={targetBill === r.billId ? { background: 'var(--accent-soft)' } : undefined}>
                <td className="num">{r.docNo}</td>
                <td className="num">{r.postingDate}</td>
                <td className="r"><Rupees value={r.creditTotal} /></td>
                <td className="r"><Rupees value={r.allocated} /></td>
                <td className="r"><Rupees value={r.outstanding} /></td>
                <td className="r">
                  <button
                    className={targetBill === r.billId ? 'btn sm primary' : 'btn ghost sm'}
                    onClick={() => aim(targetBill === r.billId ? null : r)}
                  >
                    {targetBill === r.billId ? 'Aimed here' : 'Clear this one'}
                  </button>
                </td>
              </tr>
            ))}
            {account.bills.length === 0 && (
              <tr><td colSpan={6}><Empty>Nothing outstanding</Empty></td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'paid' && (
        <table>
          <thead>
            <tr>
              <th>Receipt</th><th>Date</th><th>How</th>
              <th className="r">Amount</th><th>Against</th><th />
            </tr>
          </thead>
          <tbody>
            {account.payments.map((p) => (
              <tr key={p.paymentId} style={p.docstatus === 2 ? { color: 'var(--ink-3)' } : undefined}>
                <td className="num">
                  {p.docNo}
                  {p.docstatus === 2 && <span className="badge" style={{ marginLeft: 6 }}>cancelled</span>}
                </td>
                <td className="num">{p.postingDate}</td>
                <td>
                  {p.method === 'adjustment' ? (p.reference ?? 'Adjustment') : p.method}
                  {p.notes && <div className="src">{p.notes}</div>}
                </td>
                <td className="r"><Rupees value={p.amount} /></td>
                <td className="num" style={{ fontSize: 11.5 }}>
                  {p.allocatedTo.map((a) => a.docNo).join(', ') || <span style={{ color: 'var(--ink-3)' }}>unallocated</span>}
                </td>
                <td className="r">
                  {p.docstatus === 1 && (
                    <button className="btn ghost sm" onClick={() => void undo(p)}>Undo</button>
                  )}
                </td>
              </tr>
            ))}
            {account.payments.length === 0 && (
              <tr><td colSpan={6}><Empty>Nothing received yet</Empty></td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'statement' && statement && (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="From" hint="Blank means the whole account.">
              <input className="input num" type="date" value={from}
                onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <input className="input num" type="date" value={to}
                onChange={(e) => setTo(e.target.value)} />
            </Field>
            <button className="btn" onClick={() => { setFrom(''); setTo('') }}>Everything</button>
            <button className="btn" onClick={() => {
              const today = businessDate()
              setFrom(addDays(today, -30))
              setTo(today)
            }}>Last 30 days</button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Date</th><th>Document</th><th>What</th>
                <th className="r">Charged</th><th className="r">Paid</th><th className="r">Balance</th>
              </tr>
            </thead>
            <tbody>
              {from && (
                /* Where the window starts from, so the first balance below is not
                   a figure that appears out of nowhere. */
                <tr style={{ color: 'var(--ink-3)' }}>
                  <td className="num">{from}</td>
                  <td colSpan={4}>Balance brought forward</td>
                  <td className="r"><Rupees value={statement.openingBalance} /></td>
                </tr>
              )}
              {statement.entries.map((e) => (
                <tr key={`${e.kind}-${e.id}`}>
                  <td className="num">{e.postingDate}</td>
                  <td className="num">{e.docNo}</td>
                  <td>{e.description}</td>
                  <td className="r">
                    {e.debit > 0 ? <Rupees value={e.debit} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                  </td>
                  <td className="r">
                    {e.credit > 0 ? <Rupees value={e.credit} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                  </td>
                  <td className="r num">{Money.format(e.balance)}</td>
                </tr>
              ))}
              {statement.entries.length === 0 && (
                <tr><td colSpan={6}><Empty>Nothing on this account for that period</Empty></td></tr>
              )}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: 280 }}>
              <div className="total-line">
                <span>Bought</span><Rupees value={statement.totals.bought} />
              </div>
              <div className="total-line">
                <span>Paid</span><Rupees value={statement.totals.paid} />
              </div>
              {statement.totals.returned > 0 && (
                <div className="total-line">
                  <span>Returned</span><Rupees value={statement.totals.returned} />
                </div>
              )}
              <div className="total-line grand">
                <span>Balance due</span>
                <Rupees value={statement.closingBalance} className="amount" />
              </div>
            </div>
          </div>
        </>
      )}

      {error && <Alert>{error}</Alert>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <Field label="Amount">
          <input className="input num" id="pay-amount" value={amount}
            onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="How">
          <select className="select" id="pay-method" value={settle}
            onChange={(e) => setSettle(e.target.value as Settle)}>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="writeoff">Write off — no money</option>
          </select>
        </Field>
        <Field label={settle === 'writeoff' ? 'Why' : 'Reference'}>
          <input className="input" id="pay-ref" value={reference}
            placeholder={settle === 'writeoff' ? 'Shop closed, moved away…' : ''}
            onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
        {targetBill
          ? 'This goes against the bill highlighted above. Press its button again to go back to oldest-first.'
          : 'This settles the oldest bills first. Pick a bill above to aim it at one instead.'}
        {settle === 'writeoff' && ' Nothing enters the drawer — the day’s takings are untouched, and this can be undone from “Received”.'}
      </div>
    </Modal>
  )
}

/* --------------------------------------------------- opening balance --- */

function OpeningBalance({
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
  const [found, setFound] = useState<CustomerListItem[]>([])
  const [chosen, setChosen] = useState<CustomerListItem | null>(null)
  const [amount, setAmount] = useState('')
  const [asOf, setAsOf] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const id = setTimeout(() => { void searchCustomers(db, term, 20).then(setFound) }, 140)
    return () => clearTimeout(id)
  }, [db, term])

  const pick = usePickList({
    count: found.length,
    resetKey: term,
    onPick: (i) => { const c = found[i]; if (c) { setChosen(c); setError(null) } },
  })

  async function save() {
    if (!chosen) { setError('Choose a customer first.'); return }
    const value = Money.parseMoney(amount)
    if (value === null || value <= 0) { setError('Enter an amount greater than zero.'); return }

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
          : 'Enter an amount greater than zero.',
      )
      return
    }
    await onDone(`${result.docNo} — ${chosen.name} opens owing ${Money.formatWithSymbol(value)}.`)
  }

  return (
    <Modal
      title="What they already owed"
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
          <div className="results-anchor">
            <Field label="Customer">
              <input className="input" autoFocus placeholder="Name, phone or code"
                value={term} onChange={(e) => setTerm(e.target.value)}
                onKeyDown={pick.searchKeyDown} />
            </Field>
            {found.length > 0 && (
              <div className="results" {...pick.listProps}>
                {found.map((c, i) => (
                  <div key={c.id} style={{ padding: '7px 10px' }} {...pick.rowProps(i)}>
                    {c.name}
                    <span style={{ float: 'right', color: 'var(--ink-3)' }}>{c.code ?? c.phone ?? ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Amount owed">
          <input className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="As at" hint="Blank means today.">
          <input className="input num" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
        {customers.length} customer{customers.length === 1 ? '' : 's'} currently owe money.
      </div>
    </Modal>
  )
}

function describePayment(result: { code: string } & Record<string, unknown>): string {
  switch (result.code) {
    case 'INVALID_AMOUNT':
      return 'Enter an amount greater than zero.'
    case 'OVER_ALLOCATED':
      return `That bill only has ${Money.formatWithSymbol(result['due'] as never)} left on it. Lower the amount, or clear the oldest first instead.`
    case 'ALLOCATION_EXCEEDS_PAYMENT':
      return 'More is being put against that bill than the payment covers.'
    default:
      return 'That could not be recorded.'
  }
}
