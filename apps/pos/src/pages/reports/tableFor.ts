import { Reports as R, Quantity, type DateRange, type ClosedSession } from '@shopos/core'

/*
 * What a report holds, and the one description of each report's table that
 * the CSV and the PDF are both built from.
 */

export type Tab = 'days' | 'products' | 'margin' | 'tax' | 'tenders' | 'staff' | 'drawer'

export interface Data {
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

export function tableFor(tab: Tab, data: Data | null): Table | null {
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
export function rupeeCell(paise: number): string {
  return (paise / 100).toFixed(2)
}

export function describe(range: DateRange): string {
  return range.from === range.to ? longDate(range.from) : `${longDate(range.from)} – ${longDate(range.to)}`
}

export function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
