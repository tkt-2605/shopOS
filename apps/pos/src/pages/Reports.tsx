import { useCallback, useEffect, useState } from 'react'
import {
  Reports as R, Money, Quantity, businessDate, listRegisters, type DateRange, type Register,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Card, Stat, Empty, Alert, Rupees } from '../ui/components'
import { saveFile } from '../core/exportFile'

type Tab = 'days' | 'products' | 'margin' | 'tax' | 'tenders' | 'staff'

const TABS: { id: Tab; label: string }[] = [
  { id: 'days', label: 'By day' },
  { id: 'products', label: 'Products' },
  { id: 'margin', label: 'Profit' },
  { id: 'tax', label: 'GST' },
  { id: 'tenders', label: 'Payments' },
  { id: 'staff', label: 'Staff' },
]

interface Data {
  summary: R.SalesSummary
  days: R.DayRow[]
  products: R.ProductRow[]
  margin: R.Margin
  marginRows: R.ProductMargin[]
  tax: R.TaxRateRow[]
  tenders: R.TenderRow[]
  staff: R.StaffRow[]
}

export default function Reports() {
  const { db } = useCore()
  const [range, setRange] = useState<DateRange>(() => preset('month'))
  const [registers, setRegisters] = useState<Register[]>([])
  const [tab, setTab] = useState<Tab>('days')
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void listRegisters(db, true).then(setRegisters) }, [db])

  const load = useCallback(async () => {
    setBusy(true)
    const [summary, days, products, margin, marginRows, tax, tenders, staff] = await Promise.all([
      R.salesSummary(db, range),
      R.salesByDay(db, range),
      R.topProducts(db, range, 25),
      R.grossMargin(db, range),
      R.marginByProduct(db, range, 25),
      R.taxByRate(db, range),
      R.paymentMix(db, range),
      R.salesByStaff(db, range),
    ])
    setData({ summary, days, products, margin, marginRows, tax, tenders, staff })
    setBusy(false)
  }, [db, range])

  useEffect(() => { void load() }, [load])

  async function exportCsv() {
    setError(null)
    const { name, csv } = csvFor(tab, data)
    if (!csv) { setError('There is nothing in this range to export.'); return }

    const filename = `${name}-${range.from}-to-${range.to}.csv`
    const result = await saveFile(filename, csv)
    if (!result.ok) { setError(result.message); return }
    setNotice(`Saved to ${result.path}`)
    setTimeout(() => setNotice(null), 8000)
  }

  async function exportGstLines() {
    setError(null)
    const lines = await R.gstLines(db, range)
    if (lines.length === 0) { setError('There are no submitted bills in this range.'); return }

    const csv = R.toCsv(
      ['Bill', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Rate %', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
      lines.map((l) => [
        l.docNo, l.postingDate, l.customerName, l.gstin, l.placeOfSupply, l.rateBp / 100,
        rupeeCell(l.taxable), rupeeCell(l.cgst), rupeeCell(l.sgst), rupeeCell(l.igst), rupeeCell(l.total),
      ]),
    )
    const result = await saveFile(`gst-detail-${range.from}-to-${range.to}.csv`, csv)
    if (!result.ok) { setError(result.message); return }
    setNotice(`Saved to ${result.path}`)
    setTimeout(() => setNotice(null), 8000)
  }

  const s = data?.summary

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div className="segment">
          {(['today', 'week', 'month', 'lastMonth', 'year'] as const).map((p) => (
            <button key={p} aria-selected={sameRange(range, preset(p))} onClick={() => setRange(preset(p))}>
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-3)' }}>
          From
          <input className="input num" style={{ width: 140 }} type="date" value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-3)' }}>
          to
          <input className="input num" style={{ width: 140 }} type="date" value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </label>

        {registers.length > 1 && (
          <select
            className="select" style={{ width: 180 }} value={range.registerId ?? ''}
            onChange={(e) => setRange({ ...range, registerId: e.target.value || null })}
          >
            <option value="">All counters</option>
            {registers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}

        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => void exportGstLines()}>Export GST detail</button>
      </div>

      {!s ? (
        <Empty>{busy ? 'Working…' : 'No data'}</Empty>
      ) : (
        <>
          <div className="stat-row">
            <Stat label="Net sales" value={<Rupees value={s.net} />} sub={`${s.bills} bills, ${Money.formatWithSymbol(s.returns)} returned`} />
            <Stat label="Average bill" value={<Rupees value={s.averageBill} />} sub={describe(range)} />
            <Stat
              label="Gross profit"
              value={<Rupees value={data.margin.margin} />}
              /* A margin quoted without saying the cost is missing reads as a real
                 number, and a tile is what gets glanced at rather than read. */
              sub={
                data.margin.uncostedLines > 0
                  ? `cost missing on ${data.margin.uncostedLines} ${data.margin.uncostedLines === 1 ? 'line' : 'lines'} — overstated`
                  : `${(data.margin.marginBp / 100).toFixed(1)}% of ${Money.formatWithSymbol(data.margin.revenue)}`
              }
            />
            <Stat label="GST collected" value={<Rupees value={s.tax} />} sub={`on ${Money.formatWithSymbol(s.taxable)} taxable`} />
            <Stat label="Sold on credit" value={<Rupees value={s.credit} />} sub={`${Money.formatWithSymbol(s.paid)} taken at the counter`} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="segment">
              {TABS.map((t) => (
                <button key={t.id} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => void exportCsv()}>Export this table</button>
          </div>

          <Card>
            {tab === 'days' && <DaysTable rows={data.days} />}
            {tab === 'products' && <ProductsTable rows={data.products} />}
            {tab === 'margin' && <MarginTable rows={data.marginRows} total={data.margin} />}
            {tab === 'tax' && <TaxTable rows={data.tax} total={s.tax} />}
            {tab === 'tenders' && <TendersTable rows={data.tenders} />}
            {tab === 'staff' && <StaffTable rows={data.staff} />}
          </Card>

          {s.discount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {Money.formatWithSymbol(s.discount)} was given away as discount in this period.
            </div>
          )}
        </>
      )}
    </div>
  )
}

function DaysTable({ rows }: { rows: R.DayRow[] }) {
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

function ProductsTable({ rows }: { rows: R.ProductRow[] }) {
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

function MarginTable({ rows, total }: { rows: R.ProductMargin[]; total: R.Margin }) {
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

function TaxTable({ rows, total }: { rows: R.TaxRateRow[]; total: number }) {
  if (rows.length === 0) return <Empty>No tax was charged in this range</Empty>
  return (
    <>
      <table>
        <thead>
          <tr><th>Rate</th><th className="r">Taxable value</th><th className="r">CGST</th><th className="r">SGST</th><th className="r">IGST</th><th className="r">Tax</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rateBp}>
              <td className="num">{r.rateBp / 100}%</td>
              <td className="r"><Rupees value={r.taxable} /></td>
              <td className="r"><Rupees value={r.cgst} /></td>
              <td className="r"><Rupees value={r.sgst} /></td>
              <td className="r"><Rupees value={r.igst} /></td>
              <td className="r"><Rupees value={r.cgst + r.sgst + r.igst} /></td>
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

function TendersTable({ rows }: { rows: R.TenderRow[] }) {
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

function StaffTable({ rows }: { rows: R.StaffRow[] }) {
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

function csvFor(tab: Tab, data: Data | null): { name: string; csv: string | null } {
  if (!data) return { name: tab, csv: null }

  switch (tab) {
    case 'days':
      return {
        name: 'sales-by-day',
        csv: data.days.length === 0 ? null : R.toCsv(
          ['Date', 'Bills', 'Discount', 'GST', 'Gross', 'Returns', 'Net'],
          data.days.map((r) => [r.date, r.bills, rupeeCell(r.discount), rupeeCell(r.tax), rupeeCell(r.total), rupeeCell(r.returns), rupeeCell(r.net)]),
        ),
      }
    case 'products':
      return {
        name: 'products',
        csv: data.products.length === 0 ? null : R.toCsv(
          ['Item', 'Quantity', 'Unit', 'Bills', 'Revenue'],
          data.products.map((r) => [r.name, Quantity.formatQty(r.qty), r.unit, r.bills, rupeeCell(r.revenue)]),
        ),
      }
    case 'margin':
      return {
        name: 'profit-by-product',
        csv: data.marginRows.length === 0 ? null : R.toCsv(
          ['Item', 'Quantity', 'Unit', 'Revenue', 'Cost', 'Profit', 'Margin %'],
          data.marginRows.map((r) => [
            r.name, Quantity.formatQty(r.qty), r.unit,
            rupeeCell(r.revenue), rupeeCell(r.cost), rupeeCell(r.margin), (r.marginBp / 100).toFixed(1),
          ]),
        ),
      }
    case 'tax':
      return {
        name: 'gst-summary',
        csv: data.tax.length === 0 ? null : R.toCsv(
          ['Rate %', 'Taxable', 'CGST', 'SGST', 'IGST'],
          data.tax.map((r) => [r.rateBp / 100, rupeeCell(r.taxable), rupeeCell(r.cgst), rupeeCell(r.sgst), rupeeCell(r.igst)]),
        ),
      }
    case 'tenders':
      return {
        name: 'payments',
        csv: data.tenders.length === 0 ? null : R.toCsv(
          ['Method', 'Bills', 'Amount'],
          data.tenders.map((r) => [r.method, r.count, rupeeCell(r.amount)]),
        ),
      }
    case 'staff':
      return {
        name: 'sales-by-staff',
        csv: data.staff.length === 0 ? null : R.toCsv(
          ['Username', 'Bills', 'Total'],
          data.staff.map((r) => [r.username, r.bills, rupeeCell(r.total)]),
        ),
      }
  }
}

/** Plain rupees, no symbol and no grouping — a spreadsheet must read it as a number. */
function rupeeCell(paise: number): string {
  return (paise / 100).toFixed(2)
}

const PRESET_LABELS = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  lastMonth: 'Last month',
  year: 'This year',
} as const

function preset(which: keyof typeof PRESET_LABELS): DateRange {
  const now = new Date()
  switch (which) {
    case 'today':
      return { from: businessDate(now), to: businessDate(now) }
    case 'week': {
      const start = new Date(now)
      // Monday, because a shop's week and a spreadsheet's week should agree.
      start.setDate(now.getDate() - ((now.getDay() + 6) % 7))
      return { from: businessDate(start), to: businessDate(now) }
    }
    case 'month':
      return { from: businessDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: businessDate(now) }
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: businessDate(first), to: businessDate(last) }
    }
    case 'year':
      return { from: businessDate(new Date(now.getFullYear(), 0, 1)), to: businessDate(now) }
  }
}

function sameRange(a: DateRange, b: DateRange): boolean {
  return a.from === b.from && a.to === b.to
}

function describe(range: DateRange): string {
  return range.from === range.to ? longDate(range.from) : `${longDate(range.from)} – ${longDate(range.to)}`
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
