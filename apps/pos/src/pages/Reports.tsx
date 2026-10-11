import { useCallback, useEffect, useState } from 'react'
import {
  Reports as R, Money, listRegisters, chargesTax,
  type DateRange, type Register,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Card, Stat, Empty, Alert, Rupees, DateRangePicker, rangePreset } from '../ui/components'
import { saveFile } from '../core/exportFile'
import { reportPdf } from '../core/pdf'
import { deliverPack, say } from '../core/reportOut'
import { useShopChanged } from '../core/useShopChanged'
import { Completeness } from '../ui/Completeness'
import { type Data, type Tab, describe, rupeeCell, tableFor } from './reports/tableFor'
import {
  BooksTable, DaysTable, DrawerTable, MarginTable, ProductsTable, StaffTable, TaxTable, TendersTable,
} from './reports/tables'
import { EVERYTHING, LedgerFilters, LedgerTable, type LedgerView } from './reports/LedgerTable'
import { loadReportData, gstDetailCsv } from './reports/loadData'

const TABS: { id: Tab; label: string }[] = [
  { id: 'days', label: 'By day' },
  { id: 'products', label: 'Products' },
  { id: 'margin', label: 'Profit' },
  { id: 'tax', label: 'GST' },
  { id: 'tenders', label: 'Payments' },
  { id: 'staff', label: 'Staff' },
  { id: 'drawer', label: 'Drawer' },
  { id: 'books', label: 'Books' },
  { id: 'ledger', label: 'Ledger' },
]

export default function Reports() {
  const { db, taxScheme } = useCore()
  /* Whether there is a GST report to run at all. A composition dealer and an
     unregistered shop collect none, so the tab would be a page of zeroes and
     the export a file of them. */
  const collectsTax = chargesTax(taxScheme)
  const [range, setRange] = useState<DateRange>(() => rangePreset('month'))
  const [registers, setRegisters] = useState<Register[]>([])
  const [tab, setTab] = useState<Tab>('days')
  const [ledgerView, setLedgerView] = useState<LedgerView>(EVERYTHING)
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
      setData(await loadReportData(db, range, ledgerView))
    } catch (err) {
      setData(null)
      setError(`The reports could not be built: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [db, range, ledgerView])

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

  /* Every report for this range, as one zip: kept here, copied to the backup
     folder and emailed, as set up under Settings, Send reports. */
  async function sendAll() {
    setError(null)
    setBusy(true)
    try {
      const delivery = await deliverPack(db, range)
      const text = say(delivery)
      if (delivery.mailError || delivery.folderError) setError(text)
      else { setNotice(text); setTimeout(() => setNotice(null), 12000) }
    } catch (err) {
      setError(`The reports could not be sent: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function exportGstLines() {
    setError(null)
    const lines = await R.gstLines(db, range)
    if (lines.length === 0) { setError('There are no submitted bills in this range.'); return }

    /* Two columns a CA needs and the sheet did not have: which kind of document
       a row is, and — for a credit note — the invoice it is raised against,
       which is what GSTR-1 table 9B is filled from. */
    const csv = gstDetailCsv(lines)
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

  /**
   * GSTR-1, one file per section, in the offline tool's columns.
   *
   * The whole shop whatever counter is chosen above: a return is filed per
   * GSTIN, and a GSTR-1 of one till's bills under-declares.
   */
  async function exportGstr1() {
    setError(null)
    let sections: { section: string; csv: string }[]
    try {
      sections = R.gstr1Files(await R.gstr1(db, { from: range.from, to: range.to }))
    } catch (err) {
      setError(`That did not go through: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (sections.length === 0) { setError('There is nothing to file in this range.'); return }
    let folder = ''
    for (const { section, csv } of sections) {
      const result = await saveFile(`gstr1-${section}-${range.from}-to-${range.to}.csv`, csv)
      if (!result.ok) { setError(result.message); return }
      folder = result.path
    }
    setNotice(`Saved ${sections.length} GSTR-1 ${sections.length === 1 ? 'file' : 'files'} `
      + `(${sections.map((x) => x.section).join(', ')}) beside ${folder}`)
    setTimeout(() => setNotice(null), 10000)
  }

  /**
   * Every supplier's bill in the range, with its tax -- what a CA matches
   * against GSTR-2B -- and the input tax the shop can claim for it.
   */
  async function exportPurchases() {
    setError(null)
    let register: Awaited<ReturnType<typeof R.purchaseRegister>>
    try {
      register = await R.purchaseRegister(db, { from: range.from, to: range.to })
    } catch (err) {
      setError(`That did not go through: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (register.rows.length === 0) { setError('No supplier’s bill was posted in this range.'); return }
    const csv = R.toCsv(
      ['Entry', 'Posted', 'Supplier', 'GSTIN', 'Bill no.', 'Bill date', 'Taxable',
        'CGST', 'SGST', 'IGST', 'Cess', 'Round off', 'Total', 'Tax claimed'],
      register.rows.map((r) => [
        r.entryNo, r.postingDate, r.supplierName, r.supplierGstin, r.invoiceNo, r.invoiceDate,
        rupeeCell(r.taxable), rupeeCell(r.cgst), rupeeCell(r.sgst), rupeeCell(r.igst), rupeeCell(r.cess),
        rupeeCell(r.roundOff), rupeeCell(r.total), r.claimed ? 'Yes' : 'No — in the cost of the goods',
      ]),
    )
    const result = await saveFile(`purchase-register-${range.from}-to-${range.to}.csv`, csv)
    if (!result.ok) { setError(result.message); return }
    const c = register.claimable
    setNotice(`Saved to ${result.path}. Input tax to claim: IGST ${Money.formatWithSymbol(c.igst)}, `
      + `CGST ${Money.formatWithSymbol(c.cgst)}, SGST ${Money.formatWithSymbol(c.sgst)}, cess ${Money.formatWithSymbol(c.cess)}.`)
    setTimeout(() => setNotice(null), 12000)
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
        {collectsTax && (
          <button className="btn sm" title="B2B, B2CL, B2CS, credit notes, HSN and document summaries, for the whole shop"
            onClick={() => void exportGstr1()}>
            Export GSTR-1
          </button>
        )}
        {collectsTax && (
          <button className="btn sm" title="Every supplier’s bill, and the input tax to claim"
            onClick={() => void exportPurchases()}>
            Export purchases
          </button>
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
                <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => void exportCsv()}>Save as CSV</button>
            <button className="btn sm" onClick={() => void exportPdf()}>Save as PDF</button>
            <button className="btn sm" disabled={busy} onClick={() => void sendAll()}>Send all reports</button>
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
            {tab === 'books' && <BooksTable pl={data.pl} bs={data.bs} checks={data.checks} asOf={range.to} />}
            {tab === 'ledger' && <>
              <LedgerFilters db={db} view={ledgerView} onChange={setLedgerView} />
              <LedgerTable ledger={data.ledger} />
            </>}
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
