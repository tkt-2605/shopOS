import { useEffect, useState } from 'react'
import {
  Money, customerAccount, recordPayment, applyAdvance, refundAdvance, cancelPayment, writeOff, periodClosedMessage,
  type CustomerListItem, type CustomerStatementRow, type CustomerPayment, type CustomerAccount,
} from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { Modal, Field, Empty, Alert, Rupees } from '../../ui/components'
import { useConfirm } from '../../ui/useConfirm'
import { printStatement } from '../../core/print'
import { statementPdf } from '../../core/pdf'
import { useAction } from '../../core/useAction'
import { StatementView } from './StatementView'

/*
 * One customer's account, with everything that can be done to it in one place:
 * take a payment against a chosen bill, undo a receipt, write a debt off, and
 * print or save the statement.
 */

type Tab = 'due' | 'paid' | 'statement'

export interface Account {
  customer: CustomerListItem
  bills: CustomerStatementRow[]
  payments: CustomerPayment[]
}

/** How the money is coming in, or that it is not coming in at all. */
type Settle = 'cash' | 'upi' | 'card' | 'writeoff'

export function AccountPanel({
  account, registerId, actorId, canTake, canUndo, onClose, onChanged,
}: {
  account: Account
  registerId: string
  actorId: string
  canTake: boolean
  canUndo: boolean
  onClose: () => void
  onChanged: (message: string) => Promise<void>
}) {
  const { db } = useCore()
  const [confirmUi, ask] = useConfirm()
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
  // Every button here moves money. One press is one receipt, and an error
  // lands on this screen rather than leaving the button stuck on "Working…".
  const action = useAction(setError)
  const busy = action.busy

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
    await action.run(applyNow)
  }

  async function applyNow() {
    const value = Money.parseMoney(amount)
    if (value === null || value <= 0) { setError('Enter an amount greater than zero.'); return }
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

    if (!result.ok) { setError(describePayment(result)); return }

    const what = settle === 'writeoff' ? 'written off' : 'settled'
    await onChanged(
      result.unallocated > 0
        ? `${result.docNo} — ${Money.formatWithSymbol(result.allocated)} ${what}, ${Money.formatWithSymbol(result.unallocated)} left over.`
        : `${result.docNo} — ${Money.formatWithSymbol(result.allocated)} ${what}.`,
    )
  }

  /**
   * Spends what the shop is holding against what the customer owes.
   *
   * No money moves: this only changes which bill the money already in the till
   * is pointed at. Aimed at the highlighted bill when there is one, for the
   * same reason a payment is — "I am settling last Tuesday's" is a different
   * instruction from "settle the oldest".
   */
  async function keepAdvance() {
    await action.run(keepAdvanceNow)
  }

  async function keepAdvanceNow() {
    setError(null)
    const result = await applyAdvance(db, {
      customerId: account.customer.id,
      ...(targetBill ? { billId: targetBill } : {}),
      actorId,
    })

    if (!result.ok) {
      setError(result.code === 'NOTHING_OWED'
        ? 'There is nothing owing to put it against. It stays on their account until there is.'
        : 'There is nothing held on this account.')
      return
    }
    await onChanged(`${Money.formatWithSymbol(result.applied)} of their credit used against the khata.`)
  }

  /**
   * Hands the money back over the counter.
   *
   * Confirmed first, because unlike everything else on this screen it takes
   * cash out of the drawer, and the way to undo it is another transaction
   * rather than a button.
   */
  async function handBack() {
    if (busy || !statement) return
    const held = statement.advance
    const asked = Money.parseMoney(amount)
    /* The amount box if a figure has been typed into it, otherwise the whole
       of it. Refunding part is the ordinary case where a customer wants some
       of it back and leaves the rest on account. */
    const giving = asked !== null && asked > 0 && asked <= held ? asked : held

    if (!(await ask(
      `Hand back ${Money.formatWithSymbol(giving)} to ${account.customer.name}?`
      + ` It comes out of the drawer and is recorded against this account.`,
    ))) return

    await action.run(() => handBackNow(giving))
  }

  async function handBackNow(giving: Money.Money) {
    setError(null)
    const result = await refundAdvance(db, {
      customerId: account.customer.id,
      amount: giving,
      method: settle === 'writeoff' ? 'cash' : settle,
      reference: reference.trim(),
      registerId,
      actorId,
    })

    if (!result.ok) {
      setError(result.code === 'MORE_THAN_HELD'
        ? `Only ${Money.formatWithSymbol(result.held)} is held on this account.`
        : 'Enter an amount greater than zero.')
      return
    }
    await onChanged(
      result.left > 0
        ? `${result.docNo} — ${Money.formatWithSymbol(result.refunded)} handed back, ${Money.formatWithSymbol(result.left)} still on their account.`
        : `${result.docNo} — ${Money.formatWithSymbol(result.refunded)} handed back.`,
    )
  }

  async function undo(payment: CustomerPayment) {
    const back = payment.allocatedTo.length > 0
      ? ` ${payment.allocatedTo.map((a) => a.docNo).join(', ')} will go back on the khata.`
      : ''
    if (!(await ask(`Cancel ${payment.docNo} for ${Money.formatWithSymbol(payment.amount)}?${back}`))) return
    await action.run(async () => {
      const result = await cancelPayment(db, { paymentId: payment.paymentId, reason: 'Cancelled from the credit screen', actorId })
      if (!result.ok) {
        setError(periodClosedMessage(result.closedThrough))
        return
      }
      await onChanged(`${payment.docNo} cancelled.`)
    })
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
    <>
      {confirmUi}
      <Modal
        wide
        title={`${account.customer.name}${account.customer.code ? ` · ${account.customer.code}` : ''}`}
        onClose={onClose}
        footer={<>
          <button className="btn" onClick={() => void print()}>Print statement</button>
          <button className="btn" onClick={() => void savePdf()}>Statement as PDF</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy || !canTake} onClick={() => void apply()}>
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
          <button type="button" aria-pressed={tab === 'due'} onClick={() => setTab('due')}>What is owed</button>
          <button type="button" aria-pressed={tab === 'paid'} onClick={() => setTab('paid')}>
            Received ({account.payments.length})
          </button>
          <button type="button" aria-pressed={tab === 'statement'} onClick={() => setTab('statement')}>
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
                    {p.docstatus === 1 && canUndo && (
                      <button className="btn ghost sm" onClick={() => void undo(p)}>Cancel payment</button>
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
          <StatementView statement={statement} from={from} to={to} onFrom={setFrom} onTo={setTo} />
        )}

        {statement && statement.advance > 0 && (
          /* The two things a shop does with money it is holding. Offered here,
             next to the figure, because this is where somebody notices it —
             and until now there was nowhere to do either. */
          <div className="short-gate">
            <div className="short-gate-text">
              <div className="short-gate-head">
                Holding {Money.formatWithSymbol(statement.advance)} of theirs
              </div>
              <div className="short-gate-line">
                Paid more than was owed. Keep it against their next bill, or hand it back.
              </div>
              <div className="short-gate-note">
                Keeping it moves no money — nothing leaves the drawer and the day’s
                takings are untouched. Handing it back takes it out of the drawer
                and is recorded with its own number.
              </div>
            </div>
            <button className="btn sm" disabled={busy || !canTake} onClick={() => void keepAdvance()}>
              Use against a bill
            </button>
            <button className="btn sm" disabled={busy || !canTake} onClick={() => void handBack()}>
              Refund it
            </button>
          </div>
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
    </>
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
