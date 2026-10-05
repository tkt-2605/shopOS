import {
  Reports as R, Money, Quantity, type ClosedSession,
  type ProfitAndLoss, type BalanceSheet, type LedgerChecks, type AccountBalance,
} from '@shopos/core'
import { Empty, Alert, Rupees } from '../../ui/components'
import { longDate, titleCase } from './tableFor'

/* Each report's table as the screen shows it. The file and the page are built from `tableFor` instead. */

export function DaysTable({ rows }: { rows: R.DayRow[] }) {
  if (rows.length === 0) return <Empty>Nothing was sold in this range</Empty>
  const peak = Math.max(...rows.map((r) => r.net))

  return (
    <table>
      <thead>
        <tr><th>Date</th><th className="r">Bills</th><th className="r">GST</th><th className="r">Returns</th><th className="r">Net</th><th style={{ width: 110 }} /></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.date}>
            <td>{longDate(r.date)}</td>
            <td className="r num">{r.bills}</td>
            <td className="r"><Rupees value={r.tax} /></td>
            <td className="r">{r.returns > 0 ? <Rupees value={r.returns} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}</td>
            <td className="r"><Rupees value={r.net} /></td>
            <td><div className="bar" style={{ width: `${peak === 0 ? 0 : Math.round((r.net / peak) * 100)}%` }} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ProductsTable({ rows }: { rows: R.ProductRow[] }) {
  if (rows.length === 0) return <Empty>Nothing was sold in this range</Empty>
  return (
    <table>
      <thead>
        <tr><th>Item</th><th className="r">Sold</th><th className="r">Bills</th><th className="r">Revenue</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.productId}>
            <td>{r.name}</td>
            <td className="r num">{Quantity.formatQty(r.qty)} {r.unit}</td>
            <td className="r num">{r.bills}</td>
            <td className="r"><Rupees value={r.revenue} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function MarginTable({ rows, total }: { rows: R.ProductMargin[]; total: R.Margin }) {
  if (rows.length === 0) return <Empty>Nothing was sold in this range</Empty>

  return (
    <>
      {total.uncostedLines > 0 && (
        <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--rule-soft)' }}>
          <Alert kind="warn">
            {total.uncostedLines} sold {total.uncostedLines === 1 ? 'line was' : 'lines were'} of
            stock with no recorded cost, so the profit below is higher than the real figure.
            Record what you paid on Stock In and later sales will be costed.
          </Alert>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Item</th><th className="r">Sold</th><th className="r">Revenue</th>
            <th className="r">Cost</th><th className="r">Profit</th><th className="r">Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.productId}>
              <td>{r.name}</td>
              <td className="r num">{Quantity.formatQty(r.qty)} {r.unit}</td>
              <td className="r"><Rupees value={r.revenue} /></td>
              <td className="r"><Rupees value={r.cost} /></td>
              <td className="r"><Rupees value={r.margin} /></td>
              <td className="r num">{r.cost === 0 ? '—' : `${(r.marginBp / 100).toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--ink-3)', borderTop: '1px solid var(--rule-soft)' }}>
        Revenue and cost are both before GST, which is the only way the two compare.
        Cost is what the goods were worth as they left the shelf.
      </div>
    </>
  )
}

export function TaxTable({ rows, total }: { rows: R.TaxRateRow[]; total: number }) {
  if (rows.length === 0) return <Empty>No tax was charged in this range</Empty>
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Rate</th><th className="r">Taxable value</th><th className="r">CGST</th><th className="r">SGST</th>
            <th className="r">IGST</th><th className="r">Cess</th><th className="r">Tax</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rateBp}>
              <td className="num">{r.rateBp / 100}%</td>
              <td className="r"><Rupees value={r.taxable} /></td>
              <td className="r"><Rupees value={r.cgst} /></td>
              <td className="r"><Rupees value={r.sgst} /></td>
              <td className="r"><Rupees value={r.igst} /></td>
              <td className="r"><Rupees value={r.cess} /></td>
              <td className="r"><Rupees value={r.cgst + r.sgst + r.igst + r.cess} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--ink-3)', borderTop: '1px solid var(--rule-soft)' }}>
        {Money.formatWithSymbol(total as never)} in total. This is a working figure for your accountant,
        not a filed return.
      </div>
    </>
  )
}

export function TendersTable({ rows }: { rows: R.TenderRow[] }) {
  if (rows.length === 0) return <Empty>Nothing was taken in this range</Empty>
  const total = rows.reduce((sum, r) => sum + r.amount, 0)
  return (
    <table>
      <thead><tr><th>Method</th><th className="r">Bills</th><th className="r">Amount</th><th className="r">Share</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.method}>
            <td>{titleCase(r.method)}</td>
            <td className="r num">{r.count}</td>
            <td className="r"><Rupees value={r.amount} /></td>
            <td className="r num">{total === 0 ? '—' : `${Math.round((r.amount / total) * 100)}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Every drawer that has been counted, and by how much it was out.
 *
 * `closeSession` has written `expected_cash`, `actual_cash` and `variance`
 * since v1 and nothing read them back. A shop could see tonight's figure on the
 * screen it counted on and never again — so "is it short on the same person's
 * shift every week" had no answer anywhere in the product. It is one query and
 * a table, and it is the whole reason the column exists.
 */
export function DrawerTable({ rows }: { rows: ClosedSession[] }) {
  if (rows.length === 0) return <Empty>No drawer has been counted in this range</Empty>

  const over = rows.reduce((sum, r) => sum + Math.max(0, r.variance), 0)
  const short = rows.reduce((sum, r) => sum + Math.min(0, r.variance), 0)

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Closed</th><th>Counter</th><th>Counted by</th>
            <th className="r">Expected</th><th className="r">Counted</th><th className="r">Out by</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="num">{r.postingDate}</td>
              <td>{r.registerName}</td>
              <td>{r.closedBy ?? '—'}</td>
              <td className="r"><Rupees value={r.expectedCash} /></td>
              <td className="r"><Rupees value={r.actualCash} /></td>
              {/* Red either way. Money over is not good news — it is the same
                  evidence that something was rung up wrong, and a shop that
                  only ever looks at the shortfalls finds half the mistakes. */}
              <td className="r" style={r.variance === 0 ? undefined : { color: 'var(--danger)' }}>
                {r.variance === 0 ? '—' : Money.formatWithSymbol(r.variance)}
              </td>
              <td style={{ color: 'var(--ink-3)' }}>{r.notes ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ink-3)' }}>
        {rows.length} {rows.length === 1 ? 'close' : 'closes'} in this range
        {short !== 0 && <>, {Money.formatWithSymbol(Math.abs(short) as never)} short in total</>}
        {over !== 0 && <>, {Money.formatWithSymbol(over as never)} over</>}
        {short === 0 && over === 0 && ', every one of them exact'}.
      </div>
    </>
  )
}

export function StaffTable({ rows }: { rows: R.StaffRow[] }) {
  if (rows.length === 0) return <Empty>Nobody billed in this range</Empty>
  return (
    <table>
      <thead><tr><th>Who</th><th className="r">Bills</th><th className="r">Total</th><th className="r">Average</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId}>
            <td className="num">{r.username}</td>
            <td className="r num">{r.bills}</td>
            <td className="r"><Rupees value={r.total} /></td>
            <td className="r"><Rupees value={Math.round(r.total / r.bills)} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The books: what the period made, and what the shop owns and owes on its last
 * day. For the whole shop whatever counter is chosen -- the books are one set.
 */
export function BooksTable({ pl, bs, checks, asOf }: {
  pl: ProfitAndLoss; bs: BalanceSheet; checks: LedgerChecks; asOf: string
}) {
  const rows = (list: AccountBalance[]) => list.map((a) => (
    <tr key={a.account}><td>{a.name}</td><td className="r"><Rupees value={a.balance} /></td></tr>
  ))
  const total = (label: string, value: number) => (
    <tr><th>{label}</th><th className="r"><Rupees value={value} /></th></tr>
  )
  const agree = checks.unbalanced.length === 0 && checks.stockDrift === 0 && bs.totalAssets === bs.totalClaims

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <table>
          <thead><tr><th>Profit and loss</th><th /></tr></thead>
          <tbody>
            {rows(pl.income)}
            {total('Income', pl.totalIncome)}
            {rows(pl.expense)}
            {total('Expenses', pl.totalExpense)}
            {total(pl.profit < 0 ? 'Loss for the period' : 'Profit for the period', pl.profit)}
          </tbody>
        </table>
        <table>
          <thead><tr><th>Balance sheet on {longDate(asOf)}</th><th /></tr></thead>
          <tbody>
            {rows(bs.assets)}
            {total('What the shop owns', bs.totalAssets)}
            {rows(bs.liabilities)}
            {rows(bs.equity)}
            <tr><td>Profit retained</td><td className="r"><Rupees value={bs.retainedProfit} /></td></tr>
            {total('What it owes, and the owner’s share', bs.totalClaims)}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 12.5, color: agree ? 'var(--ink-3)' : 'var(--danger)' }}>
        {agree
          ? 'The books balance, and the stock account agrees with the stock ledger to the paisa.'
          : `The books do not agree with themselves: ${checks.unbalanced.length} unbalanced document(s), `
            + `stock off by ${Money.formatWithSymbol(checks.stockDrift)}. Tell whoever supports this till.`}
        {' '}Cash here is what was taken through the drawer; a float brought in or takings banked are not recorded yet.
      </div>
    </>
  )
}
