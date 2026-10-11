import {
  Reports as R, listSessions, profitAndLoss, balanceSheet, ledgerChecks, generalLedger,
  type DateRange, type SqlDriver,
} from '@shopos/core'
import type { Data } from './tableFor'
import { rupeeCell } from './tableFor'
import { ledgerFilter, type LedgerView } from './LedgerTable'

/**
 * Every report for a range, in one place.
 *
 * The Reports page and the pack that is emailed are built from this, so the
 * figures in an inbox cannot disagree with the ones on the screen.
 */
export async function loadReportData(db: SqlDriver, range: DateRange, ledgerView: LedgerView): Promise<Data> {
  const [summary, days, products, margin, marginRows, tax, tenders, staff, sessions, pl, bs, checks, ledger] = await Promise.all([
    R.salesSummary(db, range),
    R.salesByDay(db, range),
    R.topProducts(db, range, 25),
    R.grossMargin(db, range),
    R.marginByProduct(db, range, 25),
    R.taxByRate(db, range),
    R.paymentMix(db, range),
    R.salesByStaff(db, range),
    listSessions(db, range),
    profitAndLoss(db, range),
    balanceSheet(db, range.to),
    ledgerChecks(db),
    // The whole shop's books whatever counter is chosen, as on the books tab.
    generalLedger(db, { from: range.from, to: range.to, ...ledgerFilter(ledgerView) }),
  ])
  return { summary, days, products, margin, marginRows, tax, tenders, staff, sessions, pl, bs, checks, ledger }
}

/**
 * The GST detail a CA files from: one row per bill line, with the kind of
 * document and, for a credit note, the invoice it is raised against (GSTR-1
 * table 9B).
 */
export function gstDetailCsv(lines: Awaited<ReturnType<typeof R.gstLines>>): string {
  return R.toCsv(
    ['Document', 'Type', 'Against', 'Date', 'Customer', 'GSTIN', 'Place of supply',
      'Rate %', 'Taxable', 'CGST', 'SGST', 'IGST', 'Cess', 'Total'],
    lines.map((l) => [
      l.docNo, l.kind === 'credit_note' ? 'Credit note' : 'Invoice', l.againstDocNo ?? '',
      l.postingDate, l.customerName, l.gstin, l.placeOfSupply, l.rateBp / 100,
      rupeeCell(l.taxable), rupeeCell(l.cgst), rupeeCell(l.sgst), rupeeCell(l.igst), rupeeCell(l.cess),
      rupeeCell(l.total),
    ]),
  )
}
