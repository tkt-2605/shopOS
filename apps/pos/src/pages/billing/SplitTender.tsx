import { useRef, useState } from 'react'
import { Money } from '@shopos/core'
import type { Tender, TenderLine } from './PaymentDialog'

const ROWS: { id: Tender; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'upi', label: 'UPI' },
  { id: 'card', label: 'Card' },
  { id: 'credit', label: 'Credit' },
]

/**
 * One bill paid several ways: some in cash, the rest by UPI, or some now and
 * the rest on the customer's account.
 *
 * An amount box per tender. Stepping into an empty box fills it with whatever
 * is still left to pay, so "500 cash, rest UPI" is 500, Tab, Enter. Nothing is
 * taken until the parts add up to the bill exactly -- the service refuses
 * anything else (`PAYMENT_MISMATCH`), and the line under the boxes says how far
 * off it is before anybody presses the button. Credit needs a customer on the
 * bill, and counts against their limit like credit on its own.
 */
export function SplitTender({ due, canCredit, disabled, onPay, onBack }: {
  due: Money.Money
  canCredit: boolean
  disabled: boolean
  onPay: (tenders: TenderLine[]) => void
  onBack: () => void
}) {
  const [typed, setTyped] = useState<Record<Tender, string>>({ cash: '', upi: '', card: '', credit: '' })
  const boxes = useRef<Partial<Record<Tender, HTMLInputElement | null>>>({})
  const rows = ROWS.filter((r) => r.id !== 'credit' || canCredit)

  const parsed = rows.map((r) => ({ method: r.id, text: typed[r.id].trim(), amount: Money.parseMoney(typed[r.id]) }))
  const bad = parsed.some((p) => p.text !== '' && (p.amount === null || p.amount < 0))
  const tenders: TenderLine[] = parsed
    .filter((p) => p.amount !== null && p.amount > 0)
    .map((p) => ({ method: p.method, amount: p.amount as Money.Money }))
  const paid = tenders.reduce((sum, t) => sum + t.amount, 0)
  const left = due - paid
  const ready = !bad && left === 0 && tenders.length > 0 && !disabled

  const take = () => { if (ready) onPay(tenders) }
  const fillIfEmpty = (id: Tender) => {
    if (typed[id].trim() === '' && left > 0) {
      setTyped((t) => ({ ...t, [id]: Money.format(left as Money.Money) }))
      requestAnimationFrame(() => boxes.current[id]?.select())
    }
  }
  const next = (id: Tender) => {
    const i = rows.findIndex((r) => r.id === id)
    const after = rows[i + 1]
    if (after) boxes.current[after.id]?.focus()
  }

  return (
    <div className="split-tender" aria-label="Split payment">
      {rows.map((r, i) => (
        <div key={r.id} className="cash-tender-row">
          <label htmlFor={`split-${r.id}`} style={{ width: 70 }}>{r.label}</label>
          <input
            id={`split-${r.id}`} className="input num" style={{ width: 140 }} placeholder="0.00"
            autoFocus={i === 0}
            ref={(el) => { boxes.current[r.id] = el }}
            value={typed[r.id]}
            onFocus={() => fillIfEmpty(r.id)}
            onChange={(e) => setTyped((t) => ({ ...t, [r.id]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (ready) take(); else next(r.id)
            }}
          />
        </div>
      ))}
      <div className={`cash-change ${left !== 0 || bad ? 'warn-note' : ''}`} style={{ margin: '6px 0 10px' }}>
        {bad ? 'One of the amounts is not an amount.'
          : left > 0 ? <>Left to pay <span className="num">{Money.formatWithSymbol(left as Money.Money)}</span></>
            : left < 0 ? <>That is <span className="num">{Money.formatWithSymbol(-left as Money.Money)}</span> more than the bill</>
              : 'The parts add up to the bill.'}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn" onClick={onBack}>One way only</button>
        <button className="btn primary lg" style={{ flex: 1 }} disabled={!ready} onClick={take}>
          Take {Money.formatWithSymbol(due)}{tenders.length > 1 ? ` in ${tenders.length} parts` : ''}
        </button>
      </div>
    </div>
  )
}
