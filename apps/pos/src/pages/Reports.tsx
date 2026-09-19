import { useCallback, useEffect, useState } from 'react'
import {
  Reports as R, Money, Quantity, listRegisters, chargesTax, listSessions,
  type DateRange, type Register, type ClosedSession,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Card, Stat, Empty, Alert, Rupees, DateRangePicker, rangePreset } from '../ui/components'
import { saveFile } from '../core/exportFile'
import { reportPdf } from '../core/pdf'
import { useShopChanged } from '../core/useShopChanged'
import { Completeness } from '../ui/Completeness'

type Tab = 'days' | 'products' | 'margin' | 'tax' | 'tenders' | 'staff' | 'drawer'

const TABS: { id: Tab; label: string }[] = [
  { id: 'days', label: 'By day' },
  { id: 'products', label: 'Products' },
  { id: 'margin', label: 'Profit' },
  { id: 'tax', label: 'GST' },
  { id: 'tenders', label: 'Payments' },
  { id: 'staff', label: 'Staff' },
  { id: 'drawer', label: 'Drawer' },
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
  sessions: ClosedSession[]
}

export default function Reports() {
  const { db, taxScheme } = useCore()
  /* Whether there is a GST report to run at all. A composition dealer and an
     unregistered shop collect none, so the tab would be a page of zeroes and
     the export a file of them. */
  const collectsTax = chargesTax(taxScheme)
  const [range, setRange] = useState<DateRange>(() => rangePreset('month'))
  const [registers, setRegisters] = useState<Register[]>([])
  const [tab, setTab] = useState<Tab>('days')
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void listRegisters(db, true).then(setRegisters) }, [db])

  /**
   * Eight reports at once, and any one of them able to say what went wrong.
   *
   * Without the catch, a query that threw left this page saying "Working…" for
   * ever with nothing else on screen and nothing in the interface to suggest
   * where to look — the failure and the loading state were indistinguishable,
   * which is the worst way for a screen to be broken.
   */
  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const [summary, days, products, margin, marginRows, tax, tenders, staff, sessions] = await Promise.all([
        R.salesSummary(db, range),
        R.salesByDay(db, range),
        R.topProducts(db, range, 25),
        R.grossMargin(db, range),
        R.marginByProduct(db, range, 25),
        R.taxByRate(db, range),
        R.paymentMix(db, range),
        R.salesByStaff(db, range),
        listSessions(db, range),
      ])
      setData({ summary, days, products, margin, marginRows, tax, tenders, staff, sessions })
    } catch (err) {
      setData(null)
      setError(`The reports could not be built: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [db, range])

  useEffect(() => { void load() }, [load])
  // A report of yesterday's takings is wrong the moment the other till syncs one.
  useShopChanged(load)

  /* A shop that switches to composition while looking at the GST tab would
     otherwise be left on a tab that is no longer offered, with no way back to
     it and no way off it. */
  useEffect(() => { if (!collectsTax && tab === 'tax') setTab('days') }, [collectsTax, tab])

  async function exportCsv() {
    setError(null)
    const table = tableFor(tab, data)
    if (!table || table.rows.length === 0) {
      setError('There is nothing in this range to export.')
      return
    }

    const csv = R.toCsv(table.columns.map((c) => c.label), table.rows)
    const result = await saveFile(`${table.name}-${range.from}-to-${range.to}.csv`, csv)
    if (!result.ok) { setError(result.message); return }
    setNotice(`Saved to ${result.path}`)
    setTimeout(() => setNotice(null), 8000)
  }

  /* The same table, laid out for reading rather than for a spreadsheet. Built
     from what is on screen rather than re-queried, so the page an accountant
     gets cannot disagree with what the owner was looking at. */
  async function exportPdf() {
    setError(null)
    const table = tableFor(tab, data)
    if (!table || table.rows.length === 0) {
      setError('There is nothing in this range to save.')
      return
    }

    const result = await reportPdf(db, {
      title: table.title,
      range: { from: range.from, to: range.to },
      columns: table.columns.map((c) => ({
        label: c.label, width: c.width, ...(c.right ? { alignRight: true } : {}),
      })),
      rows: table.rows,
    })
    if (!result.ok) { setError(result.message); return }
    setNotice(`Saved to ${result.path}`)
    setTimeout(() => setNotice(null), 8000)
  }

  async function exportGstLines() {
    setError(null)
    const lines = await R.gstLines(db, range)
    if (lines.length === 0) { setError('There are no submitted bills in this range.'); return }

    /* Two columns a CA needs and the sheet did not have: which kind of document
       a row is, and — for a credit note — the invoice it is raised against,
       which is what GSTR-1 table 9B is filled from. */
    const csv = R.toCsv(
      ['Document', 'Type', 'Against', 'Date', 'Customer', 'GSTIN', 'Place of supply',
        'Rate %', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
      lines.map((l) => [
        l.docNo, l.kind === 'credit_note' ? 'Credit note' : 'Invoice', l.againstDocNo ?? '',
        l.postingDate, l.customerName, l.gstin, l.placeOfSupply, l.rateBp / 100,
        rupeeCell(l.taxable), rupeeCell(l.cgst), rupeeCell(l.sgst), rupeeCell(l.igst), rupeeCell(l.total),
      ]),
    )
    const result = await saveFile(`gst-detail-${range.from}-to-${range.to}.csv`, csv)
    if (!result.ok) { setError(result.message); return }

    /* The lines a CA will come back about, saved beside the export rather than
       inside it: a CSV with two shapes of row in it is a CSV a spreadsheet
       cannot read. Written only when there is something to say. */
    const exceptions = await R.gstExceptions(db, range)
    if (exceptions.length > 0) {
      await saveFile(
        `gst-exceptions-${range.from}-to-${range.to}.csv`,
        R.toCsv(
          ['Bill', 'Date', 'Customer', 'GSTIN', 'Item', 'Taxable', 'Problem'],
          exceptions.map((e) => [
            e.docNo, e.postingDate, e.customerName, e.gstin, e.productName,
            rupeeCell(e.taxable), e.problem,
          ]),
        ),
      )
    }

    setNotice(
      exceptions.length > 0
        ? `Saved to ${result.path}. ${exceptions.length} ${exceptions.length === 1 ? 'line needs' : 'lines need'} `
          + 'an HSN code before filing — saved beside it as gst-exceptions.'
        : `Saved to ${result.path}`,
    )
    setTimeout(() => setNotice(null), 8000)
  }

  const s = data?.summary

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}
      {/* What these figures are figures of. GSTR-1 is filed off the tax tab
          below, and until this line the screen said nothing at all about
          whether the other counter's bills were in it. */}
      <Completeness />

      <div className="filter-bar">
        <DateRangePicker value={range} onChange={setRange} />

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
        {collectsTax && (
          <button className="btn sm" onClick={() => void exportGstLines()}>Export GST detail</button>
        )}
      </div>

      {!s ? (
        <Empty>
          {busy ? 'Working…' : error ? 'Nothing to show — see the message above.' : 'No data'}
        </Empty>
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
            {/* A shop that may not collect GST has none to report, and a tile
                reading ₹0.00 for ever is a tile that teaches people the row
                means nothing. The sentence under the tabs says why it is gone,
                because a missing report with no explanation reads as a fault. */}
            {collectsTax && (
              <Stat label="GST collected" value={<Rupees value={s.tax} />} sub={`on ${Money.formatWithSymbol(s.taxable)} taxable`} />
            )}
            <Stat label="Sold on credit" value={<Rupees value={s.credit} />} sub={`${Money.formatWithSymbol(s.paid)} taken at the counter`} />
            {/* Only when the shop rounds. A tile reading ₹0.00 every day on a
                counter that charges what the bill comes to is a tile that
                teaches people to stop reading the row. */}
            {s.roundOff !== 0 && (
              <Stat
                label="Rounded off"
                value={<Rupees value={s.roundOff} />}
                sub={s.roundOff < 0 ? 'given up over the period' : 'collected over the period'}
              />
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="segment">
              {TABS.filter((t) => t.id !== 'tax' || collectsTax).map((t) => (
                <button key={t.id} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => void exportCsv()}>Save as CSV</button>
            <button className="btn sm" onClick={() => void exportPdf()}>Save as PDF</button>
          </div>

          {!collectsTax && (
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {taxScheme === 'composition'
                ? 'This shop is on the composition scheme, so it does not collect GST from customers and there is no GST report to run. The bills go out as a Bill of Supply.'
                : 'This shop is not registered for GST, so it does not charge it and there is no GST report to run. Settings is where that changes.'}
            </div>
          )}

          <Card>
            {tab === 'days' && <DaysTable rows={data.days} />}
            {tab === 'products' && <ProductsTable rows={data.products} />}
            {tab === 'margin' && <MarginTable rows={data.marginRows} total={data.margin} />}
            {tab === 'tax' && <TaxTable rows={data.tax} total={s.tax} />}
            {tab === 'tenders' && <TendersTable rows={data.tenders} />}
            {tab === 'staff' && <StaffTable rows={data.staff} />}
            {tab === 'drawer' && <DrawerTable rows={data.sessions} />}
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

/**
 * Every drawer that has been counted, and by how much it was out.
 *
 * `closeSession` has written `expected_cash`, `actual_cash` and `variance`
 * since v1 and nothing read them back. A shop could see tonight's figure on the
 * screen it counted on and never again — so "is it short on the same person's
 * shift every week" had no answer anywhere in the product. It is one query and
 * a table, and it is the whole reason the column exists.
 */
function DrawerTable({ rows }: { rows: ClosedSession[] }) {
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

/**
 * One description of each report's table, which both the CSV and the PDF are
 * built from.
 *
 * Kept as one because the alternative — a list of columns for the spreadsheet
 * and another for the page — is two lists that quietly stop agreeing, and the
 * first anybody hears of it is an accountant looking at a column that is not
 * the one it is labelled.
 *
 * `width` is a share of the page and is ignored by the CSV; `right` marks the
 * figures, which the PDF sets in a monospaced face so they line up.
 */
interface TableColumn {
  label: string
  width: number
  right?: boolean
}

interface Table {
  /** For the filename. */
  name: string
  /** For the heading on the page. */
  title: string
  columns: TableColumn[]
  rows: string[][]
}

function tableFor(tab: Tab, data: Data | null): Table | null {
  if (!data) return null

  switch (tab) {
    case 'days':
      return {
        name: 'sales-by-day',
        title: 'Sales by day',
        columns: [
          { label: 'Date', width: 1.4 },
          { label: 'Bills', width: 0.7, right: true },
          { label: 'Discount', width: 1 , right: true },
          { label: 'GST', width: 1, right: true },
          { label: 'Gross', width: 1.1, right: true },
          { label: 'Returns', width: 1, right: true },
          { label: 'Net', width: 1.1, right: true },
        ],
        rows: data.days.map((r) => [
          r.date, String(r.bills), rupeeCell(r.discount), rupeeCell(r.tax),
          rupeeCell(r.total), rupeeCell(r.returns), rupeeCell(r.net),
        ]),
      }
    case 'products':
      return {
        name: 'products',
        title: 'What sold',
        columns: [
          { label: 'Item', width: 3.4 },
          { label: 'Quantity', width: 1, right: true },
          { label: 'Unit', width: 0.8 },
          { label: 'Bills', width: 0.7, right: true },
          { label: 'Revenue', width: 1.2, right: true },
        ],
        rows: data.products.map((r) => [
          r.name, Quantity.formatQty(r.qty), r.unit, String(r.bills), rupeeCell(r.revenue),
        ]),
      }
    case 'margin':
      return {
        name: 'profit-by-product',
        title: 'Profit by product',
        columns: [
          { label: 'Item', width: 2.8 },
          { label: 'Quantity', width: 0.9, right: true },
          { label: 'Unit', width: 0.7 },
          { label: 'Revenue', width: 1, right: true },
          { label: 'Cost', width: 1, right: true },
          { label: 'Profit', width: 1, right: true },
          { label: 'Margin %', width: 0.9, right: true },
        ],
        rows: data.marginRows.map((r) => [
          r.name, Quantity.formatQty(r.qty), r.unit,
          rupeeCell(r.revenue), rupeeCell(r.cost), rupeeCell(r.margin), (r.marginBp / 100).toFixed(1),
        ]),
      }
    case 'tax':
      return {
        name: 'gst-summary',
        title: 'GST summary',
        columns: [
          { label: 'Rate %', width: 1, right: true },
          { label: 'Taxable', width: 1.4, right: true },
          { label: 'CGST', width: 1.2, right: true },
          { label: 'SGST', width: 1.2, right: true },
          { label: 'IGST', width: 1.2, right: true },
        ],
        rows: data.tax.map((r) => [
          (r.rateBp / 100).toString(), rupeeCell(r.taxable),
          rupeeCell(r.cgst), rupeeCell(r.sgst), rupeeCell(r.igst),
        ]),
      }
    case 'tenders':
      return {
        name: 'payments',
        title: 'How they paid',
        columns: [
          { label: 'Method', width: 2 },
          { label: 'Bills', width: 1, right: true },
          { label: 'Amount', width: 1.4, right: true },
        ],
        rows: data.tenders.map((r) => [r.method, String(r.count), rupeeCell(r.amount)]),
      }
    case 'staff':
      return {
        name: 'sales-by-staff',
        title: 'Sales by staff',
        columns: [
          { label: 'Username', width: 2 },
          { label: 'Bills', width: 1, right: true },
          { label: 'Total', width: 1.4, right: true },
        ],
        rows: data.staff.map((r) => [r.username, String(r.bills), rupeeCell(r.total)]),
      }
    case 'drawer':
      return {
        name: 'drawer-closes',
        title: 'Drawer closes',
        columns: [
          { label: 'Closed', width: 1.2 },
          { label: 'Counter', width: 1.4 },
          { label: 'Counted by', width: 1.4 },
          { label: 'Expected', width: 1.2, right: true },
          { label: 'Counted', width: 1.2, right: true },
          { label: 'Out by', width: 1.1, right: true },
          { label: 'Note', width: 2 },
        ],
        rows: data.sessions.map((r) => [
          r.postingDate, r.registerName, r.closedBy ?? '',
          rupeeCell(r.expectedCash), rupeeCell(r.actualCash), rupeeCell(r.variance),
          r.notes ?? '',
        ]),
      }
  }
}

/** Plain rupees, no symbol and no grouping — a spreadsheet must read it as a number. */
function rupeeCell(paise: number): string {
  return (paise / 100).toFixed(2)
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
