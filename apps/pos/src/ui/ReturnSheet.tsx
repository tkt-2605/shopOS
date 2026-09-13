import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Money, Quantity, previewReturn, processReturn,
  type BillDetail, type RefundMethod, type ReturnPreview, type ProcessReturnResult,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Alert, Rupees, Field } from './components'

/**
 * Taking goods back.
 *
 * The counter is told what will happen before it happens: which lines, how much
 * money, how many points, and where the money is coming from. A refund is the
 * one transaction a shop cannot undo by handing the goods back, so the figure is
 * shown and agreed rather than discovered afterwards.
 *
 * The arithmetic is not here. `previewReturn` answers with exactly what
 * `processReturn` will do, from the same code, so the number read out to the
 * customer is the number that is paid.
 */

const METHODS: { id: RefundMethod; label: string; note: string }[] = [
  { id: 'cash', label: 'Cash', note: 'Out of the drawer that is open now.' },
  { id: 'upi', label: 'UPI', note: 'Sent back the way it came.' },
  { id: 'card', label: 'Card', note: 'Reversed on the machine.' },
  { id: 'credit', label: 'Off their khata', note: 'Takes the amount off what they owe.' },
]

export function ReturnSheet({
  bill, onClose, onDone,
}: {
  bill: BillDetail
  onClose: () => void
  onDone: (message: string) => void
}) {
  const { db } = useCore()
  const user = useUser()

  /** What is still on the bill and has not come back yet. */
  const returnable = useMemo(
    () => bill.items
      .map((item) => ({ item, left: Quantity.subQty(item.qty, item.returnedQty) }))
      .filter(({ left }) => left > 0),
    [bill.items],
  )

  const [qtys, setQtys] = useState<Record<string, string>>({})
  const [method, setMethod] = useState<RefundMethod>('cash')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<ReturnPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const lines = useMemo(
    () => Object.entries(qtys)
      .map(([billItemId, typed]) => ({ billItemId, qty: Quantity.parseQty(typed.trim()) }))
      .filter((l): l is { billItemId: string; qty: Quantity.Qty } => l.qty !== null && l.qty > 0),
    [qtys],
  )

  const look = useCallback(async () => {
    if (lines.length === 0) { setPreview(null); setProblem(null); return }
    const result = await previewReturn(db, { billId: bill.id, lines })
    if (result.ok) { setPreview(result); setProblem(null); return }
    setPreview(null)
    setProblem(describeProblem(result, bill))
  }, [db, bill, lines])

  useEffect(() => { void look() }, [look])

  async function confirm() {
    if (lines.length === 0 || busy) return
    setBusy(true)
    const result = await processReturn(db, {
      billId: bill.id,
      lines,
      refundMethod: method,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      actorId: user.id,
    })
    setBusy(false)

    if (!result.ok) { setProblem(describeProblem(result, bill)); return }

    const parts: string[] = []
    if (result.refundCash > 0) {
      parts.push(
        method === 'credit'
          ? `${Money.formatWithSymbol(result.refundCash)} off their khata`
          : `${Money.formatWithSymbol(result.refundCash)} back`,
      )
    }
    if (result.pointsRestored > 0) parts.push(`${result.pointsRestored} points returned`)
    if (result.pointsClawedBack > 0) parts.push(`${result.pointsClawedBack} points taken off`)
    onDone(`${result.docNo} — ${parts.join(', ') || 'nothing to pay back'}.`)
  }

  const takeAll = () => setQtys(Object.fromEntries(
    returnable.map(({ item, left }) => [item.id, String(Quantity.toUnits(left))]),
  ))

  return (
    <Modal
      wide
      title={`Take goods back — ${bill.docNo}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={takeAll}>Everything on the bill</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || preview === null}
            onClick={() => void confirm()}
          >
            {busy ? 'Working…' : preview ? `Refund ${describeHandover(preview, method)}` : 'Refund'}
          </button>
        </>
      }
    >
      {returnable.length === 0 && (
        <Alert>Everything on this bill has already come back.</Alert>
      )}

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="r">Bought</th>
            <th className="r">Already back</th>
            <th className="r" style={{ width: 120 }}>Coming back</th>
            <th className="r">Refund</th>
          </tr>
        </thead>
        <tbody>
          {returnable.map(({ item, left }) => {
            const line = preview?.lines.find((l) => l.billItemId === item.id)
            return (
              <tr key={item.id}>
                <td>
                  {item.productName}
                  <div className="src">{Quantity.formatQty(item.qty)} {item.saleUnit} at {Money.format(item.rate)}</div>
                </td>
                <td className="r num">{Quantity.formatQty(item.qty)}</td>
                <td className="r num">
                  {item.returnedQty > 0
                    ? Quantity.formatQty(item.returnedQty)
                    : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                </td>
                <td className="r">
                  <input
                    className="qty-input num"
                    inputMode="decimal"
                    placeholder="0"
                    value={qtys[item.id] ?? ''}
                    onChange={(e) => setQtys({ ...qtys, [item.id]: e.target.value })}
                  />
                  <div className="src" style={{ textAlign: 'right' }}>
                    up to {Quantity.formatQty(left)}
                  </div>
                </td>
                <td className="r">
                  {line ? <Rupees value={line.refund} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {problem && <Alert>{problem}</Alert>}

      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 7 }}>How it goes back</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
          {METHODS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMethod(m.id)}
              style={{
                textAlign: 'left', padding: '8px 11px', cursor: 'pointer',
                background: method === m.id ? 'var(--accent-soft)' : 'var(--surface)',
                border: method === m.id ? '2px solid var(--accent)' : '1px solid var(--rule-strong)',
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.label}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{m.note}</div>
            </button>
          ))}
        </div>
      </div>

      <Field label="Why" hint="Kept on the return, and on the history page.">
        <input
          className="input"
          placeholder="Wrong size, damaged, changed their mind…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>

      {preview && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 300 }}>
            <div className="total-line">
              <span>Goods coming back</span><Rupees value={preview.refundTotal} />
            </div>
            {preview.pointsRestored > 0 && (
              <>
                <div className="total-line">
                  <span>Paid for with points</span>
                  <span className="num">{preview.pointsRestored} pts</span>
                </div>
                {/* The part the shop never took in money, so the part it does not
                    hand back in money. */}
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: '-4px 0 7px' }}>
                  This bill was settled partly with points, so part of it goes back as points.
                </div>
              </>
            )}
            <div className="total-line grand">
              <span>{method === 'credit' ? 'Off their khata' : 'To hand back'}</span>
              <Rupees value={preview.cash} className="amount" />
            </div>
            {preview.pointsRemoved > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 6 }}>
                {preview.pointsRemoved} point{preview.pointsRemoved === 1 ? '' : 's'} earned on this
                sale will come off.
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function describeHandover(preview: ReturnPreview, method: RefundMethod): string {
  const money = Money.formatWithSymbol(preview.cash)
  const cash = method === 'credit' ? `${money} off the khata` : money
  return preview.pointsRestored > 0 ? `${cash} and ${preview.pointsRestored} pts` : cash
}

type Refusal =
  | Extract<ProcessReturnResult, { ok: false }>
  | Extract<Awaited<ReturnType<typeof previewReturn>>, { ok: false }>

function describeProblem(result: Refusal, bill: BillDetail): string {
  switch (result.code) {
    case 'RETURN_BLOCKED':
      return `${result.productName} is not taken back once it has left the shop.`
    case 'EXCEEDS_RETURNABLE': {
      const item = bill.items.find((i) => i.id === result.billItemId)
      return `${item?.productName ?? 'That line'} has only ${Quantity.formatQty(result.returnable)} left to come back.`
    }
    case 'NOTHING_TO_CREDIT':
      return result.outstanding > 0
        ? `Only ${Money.formatWithSymbol(result.outstanding)} is owed on this account, and the refund is ${Money.formatWithSymbol(result.refund)}. Pay the difference in cash, or take back less.`
        : 'This customer owes nothing, so there is nothing to take the refund off. Refund it in cash.'
    case 'BILL_CANCELLED':
      return 'This bill has been cancelled, so there is nothing to return against.'
    case 'BILL_NOT_SUBMITTED':
      return 'This bill was never completed.'
    case 'NO_LINES':
      return 'Nothing has been entered to come back.'
    case 'UNKNOWN_LINE':
      return 'That line is not on this bill any more. Close this and open the bill again.'
  }
}
