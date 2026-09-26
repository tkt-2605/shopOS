import { Money, businessDate, addDays, type CustomerAccount } from '@shopos/core'
import { Field, Empty, Rupees } from '../../ui/components'

/**
 * The account as a bank would state it: one line per document, what it
 * charged, what it took off, and what was owed after it -- over the whole
 * account, or a window of it.
 *
 * The window belongs to the panel, which prints and saves the same one, so it
 * is handed in rather than kept here.
 */
export function StatementView({ statement, from, to, onFrom, onTo }: {
  statement: CustomerAccount
  from: string
  to: string
  onFrom: (date: string) => void
  onTo: (date: string) => void
}) {
  return (
    <>
      {/* The hint belongs under the row, not under one field. A `Field`
          with a hint is a line taller than one without, and in a
          `flex-end` row that lifted the From box a whole line above the
          To box beside it — which is what this looked like until now. */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="From">
          <input className="input num" type="date" value={from}
            onChange={(e) => onFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input className="input num" type="date" value={to}
            onChange={(e) => onTo(e.target.value)} />
        </Field>
        <button className="btn" onClick={() => { onFrom(''); onTo('') }}>Everything</button>
        <button className="btn" onClick={() => {
          const today = businessDate()
          onFrom(addDays(today, -30))
          onTo(today)
        }}>Last 30 days</button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        Blank means the whole account.
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
          {/* "Balance due -490.00" is what this used to say, and a
              negative amount due reads as a mistake in the arithmetic
              rather than as money. It is the shop holding 490 of theirs,
              so it is put in those words and the minus sign goes. */}
          {statement.closingBalance < 0 ? (
            <div className="total-line grand">
              <span>In credit</span>
              <Rupees value={-statement.closingBalance as never} className="amount" />
            </div>
          ) : (
            <div className="total-line grand">
              <span>Balance due</span>
              <Rupees value={statement.closingBalance} className="amount" />
            </div>
          )}
        </div>
      </div>
    </>
  )
}
