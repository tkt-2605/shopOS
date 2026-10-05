import type { Money } from '../money.js'
import { stateName } from './states.js'
import { toCsv } from './csv.js'

/**
 * GSTR-1, in the sections it is filed in.
 *
 * The GST tab used to hand a CA one export, a row per document per rate, and
 * leave the sorting to them: which invoices go to B2B, which unregistered ones
 * are large enough for B2CL, what nets into B2CS, which credit notes are CDNR
 * and which CDNUR, and the HSN summary (Table 12) and document summary (Table
 * 13) that every return now needs. Each of those is a rule, and a rule applied
 * by hand at month end is applied differently each month. So the rules are
 * here, once, and pure -- the queries that feed them are in
 * `repos/reports/gstr1.ts`.
 *
 * Every figure is the document's own: the taxable value and the tax were
 * written when the bill was submitted, and nothing here recomputes them.
 */

/** One invoice's figures at one rate. */
export interface InvoiceRate {
  invoiceNo: string
  invoiceDate: string
  /** What the invoice came to, round-off included -- the "invoice value". */
  invoiceValue: Money
  customerName: string | null
  gstin: string | null
  /** The state code the supply was made to; null on a walk-in sale. */
  placeOfSupply: string | null
  supplyType: 'intra_state' | 'inter_state' | null
  rateBp: number
  taxable: Money
  igst: Money
  cgst: Money
  sgst: Money
  cess: Money
}

/** One credit note's figures at one rate, with the invoice it reverses. */
export interface NoteRate {
  noteNo: string
  noteDate: string
  /** The note's whole value, across every rate on it. */
  noteValue: Money
  invoiceNo: string
  invoiceDate: string
  invoiceValue: Money
  customerName: string | null
  gstin: string | null
  placeOfSupply: string | null
  supplyType: 'intra_state' | 'inter_state' | null
  rateBp: number
  taxable: Money
  igst: Money
  cgst: Money
  sgst: Money
  cess: Money
}

/** Goods by HSN, rate and unit, sold or (negative) returned, to registered buyers or not. */
export interface HsnMovement {
  hsn: string
  description: string
  /** The item's counting unit, which becomes the UQC. */
  unit: string
  rateBp: number
  registered: boolean
  /** In base units, scaled x10^4 like every quantity here. */
  qty: number
  value: Money
  taxable: Money
  igst: Money
  cgst: Money
  sgst: Money
  cess: Money
}

/** A numbered document, for the document summary. */
export interface NumberedDoc {
  nature: 'invoice' | 'credit_note'
  docNo: string
  cancelled: boolean
}

export interface B2bRow {
  gstin: string; receiverName: string; invoiceNo: string; invoiceDate: string; invoiceValue: Money
  placeOfSupply: string; rateBp: number; taxable: Money; cess: Money
}
export interface B2clRow {
  invoiceNo: string; invoiceDate: string; invoiceValue: Money; placeOfSupply: string
  rateBp: number; taxable: Money; cess: Money
}
export interface B2csRow { placeOfSupply: string; rateBp: number; taxable: Money; cess: Money }
export interface CdnrRow {
  gstin: string; receiverName: string; noteNo: string; noteDate: string; noteValue: Money
  placeOfSupply: string; rateBp: number; taxable: Money; cess: Money
}
export interface CdnurRow {
  noteNo: string; noteDate: string; noteValue: Money; placeOfSupply: string
  rateBp: number; taxable: Money; cess: Money
}
export interface HsnRow {
  hsn: string; description: string; uqc: string; qty: number; value: Money
  rateBp: number; taxable: Money; igst: Money; cgst: Money; sgst: Money; cess: Money
}
export interface DocSummaryRow {
  nature: 'Invoices for outward supply' | 'Credit Note'
  from: string; to: string; total: number; cancelled: number
}

export interface Gstr1 {
  b2b: B2bRow[]
  b2cl: B2clRow[]
  b2cs: B2csRow[]
  cdnr: CdnrRow[]
  cdnur: CdnurRow[]
  /** Table 12, split as the return has asked since May 2025. */
  hsnB2b: HsnRow[]
  hsnB2c: HsnRow[]
  /** Table 13. */
  docs: DocSummaryRow[]
}

/**
 * The value above which an unregistered inter-state invoice is B2CL.
 *
 * ₹2,50,000 until 31 July 2024, and ₹1,00,000 from 1 August 2024
 * (Notification 12/2024 – Central Tax). Dated by the invoice, so a return for
 * a month on either side of the change is classified by its own rule.
 */
export function b2clThreshold(invoiceDate: string): Money {
  return (invoiceDate >= '2024-08-01' ? 10_000_000 : 25_000_000) as Money
}

/**
 * A counting unit as GSTN's Unit Quantity Code. Anything not recognised is
 * OTH, which the portal accepts and a CA can correct; guessing would not be.
 */
export function uqcFor(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/\.$/, '')
  const known: Record<string, string> = {
    piece: 'PCS', pieces: 'PCS', pc: 'PCS', pcs: 'PCS', nos: 'NOS', no: 'NOS', number: 'NOS',
    kg: 'KGS', kgs: 'KGS', kilogram: 'KGS', g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS',
    l: 'LTR', litre: 'LTR', liter: 'LTR', ltr: 'LTR', ml: 'MLT',
    m: 'MTR', metre: 'MTR', meter: 'MTR', mtr: 'MTR', cm: 'CMS',
    box: 'BOX', bag: 'BAG', bottle: 'BTL', btl: 'BTL', pack: 'PAC', packet: 'PAC', pkt: 'PAC',
    dozen: 'DOZ', doz: 'DOZ', pair: 'PRS', set: 'SET', roll: 'ROL', bundle: 'BDL', tin: 'CAN', can: 'CAN',
  }
  return known[u] ?? 'OTH'
}

function interState(row: { supplyType: string | null; placeOfSupply: string | null }, shopState: string | null): boolean {
  if (row.supplyType === 'inter_state') return true
  if (row.supplyType === 'intra_state') return false
  // A bill from before 028 carries no snapshot; its place of supply decides.
  return row.placeOfSupply !== null && shopState !== null && row.placeOfSupply !== shopState
}

function registered(gstin: string | null): boolean {
  return gstin !== null && gstin.trim() !== ''
}

const add = (a: number, b: number) => (a + b) as Money

/** Gathers a period's documents into the return's sections. */
export function buildGstr1(input: {
  shopState: string | null
  invoices: InvoiceRate[]
  notes: NoteRate[]
  hsn: HsnMovement[]
  numbered: NumberedDoc[]
}): Gstr1 {
  const { shopState } = input
  const b2b: B2bRow[] = []
  const b2cl: B2clRow[] = []
  const b2cs = new Map<string, B2csRow>()
  const cdnr: CdnrRow[] = []
  const cdnur: CdnurRow[] = []

  const intoB2cs = (pos: string | null, rateBp: number, taxable: number, cess: number) => {
    const place = pos ?? shopState ?? ''
    const key = `${place}|${rateBp}`
    const row = b2cs.get(key) ?? { placeOfSupply: place, rateBp, taxable: 0 as Money, cess: 0 as Money }
    b2cs.set(key, { ...row, taxable: add(row.taxable, taxable), cess: add(row.cess, cess) })
  }

  for (const r of input.invoices) {
    if (registered(r.gstin)) {
      b2b.push({
        gstin: r.gstin!.trim(), receiverName: r.customerName ?? '', invoiceNo: r.invoiceNo,
        invoiceDate: r.invoiceDate, invoiceValue: r.invoiceValue, placeOfSupply: r.placeOfSupply ?? shopState ?? '',
        rateBp: r.rateBp, taxable: r.taxable, cess: r.cess,
      })
    } else if (interState(r, shopState) && r.invoiceValue > b2clThreshold(r.invoiceDate)) {
      b2cl.push({
        invoiceNo: r.invoiceNo, invoiceDate: r.invoiceDate, invoiceValue: r.invoiceValue,
        placeOfSupply: r.placeOfSupply ?? '', rateBp: r.rateBp, taxable: r.taxable, cess: r.cess,
      })
    } else {
      intoB2cs(r.placeOfSupply, r.rateBp, r.taxable, r.cess)
    }
  }

  for (const n of input.notes) {
    if (registered(n.gstin)) {
      cdnr.push({
        gstin: n.gstin!.trim(), receiverName: n.customerName ?? '', noteNo: n.noteNo, noteDate: n.noteDate,
        noteValue: n.noteValue, placeOfSupply: n.placeOfSupply ?? shopState ?? '',
        rateBp: n.rateBp, taxable: n.taxable, cess: n.cess,
      })
    } else if (interState(n, shopState) && n.invoiceValue > b2clThreshold(n.invoiceDate)) {
      // Against a B2CL invoice: the one unregistered note the return lists on its own.
      cdnur.push({
        noteNo: n.noteNo, noteDate: n.noteDate, noteValue: n.noteValue, placeOfSupply: n.placeOfSupply ?? '',
        rateBp: n.rateBp, taxable: n.taxable, cess: n.cess,
      })
    } else {
      // Against a small B2C sale: B2CS is declared net, so the note comes off it.
      intoB2cs(n.placeOfSupply, n.rateBp, -n.taxable, -n.cess)
    }
  }

  return {
    b2b, b2cl,
    b2cs: [...b2cs.values()].filter((r) => r.taxable !== 0 || r.cess !== 0)
      .sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rateBp - b.rateBp),
    cdnr, cdnur,
    hsnB2b: hsnRows(input.hsn.filter((h) => h.registered)),
    hsnB2c: hsnRows(input.hsn.filter((h) => !h.registered)),
    docs: docSummary(input.numbered),
  }
}

function hsnRows(movements: HsnMovement[]): HsnRow[] {
  const rows = new Map<string, HsnRow>()
  for (const m of movements) {
    const uqc = uqcFor(m.unit)
    const key = `${m.hsn}|${m.rateBp}|${uqc}`
    const row = rows.get(key) ?? {
      hsn: m.hsn, description: m.description, uqc, qty: 0, value: 0 as Money, rateBp: m.rateBp,
      taxable: 0 as Money, igst: 0 as Money, cgst: 0 as Money, sgst: 0 as Money, cess: 0 as Money,
    }
    rows.set(key, {
      ...row,
      qty: row.qty + m.qty,
      value: add(row.value, m.value), taxable: add(row.taxable, m.taxable),
      igst: add(row.igst, m.igst), cgst: add(row.cgst, m.cgst), sgst: add(row.sgst, m.sgst), cess: add(row.cess, m.cess),
    })
  }
  return [...rows.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rateBp - b.rateBp)
}

/**
 * Table 13: each series, its first and last number, how many and how many
 * cancelled. A series is everything before the running number -- `BMR/2627/`
 * -- so each counter's invoices and the credit notes are their own rows.
 */
interface Series {
  nature: NumberedDoc['nature']
  stem: string
  numbers: number[]
  names: Map<number, string>
  cancelled: number
}

function docSummary(docs: NumberedDoc[]): DocSummaryRow[] {
  const series = new Map<string, Series>()
  for (const d of docs) {
    const cut = d.docNo.lastIndexOf('/')
    const stem = cut >= 0 ? d.docNo.slice(0, cut + 1) : ''
    const n = Number(d.docNo.slice(cut + 1))
    if (!Number.isFinite(n)) continue
    const key = `${d.nature}|${stem}`
    const s: Series = series.get(key) ?? { nature: d.nature, stem, numbers: [], names: new Map(), cancelled: 0 }
    s.numbers.push(n)
    s.names.set(n, d.docNo)
    if (d.cancelled) s.cancelled += 1
    series.set(key, s)
  }
  return [...series.values()]
    .sort((a, b) => a.nature.localeCompare(b.nature) || a.stem.localeCompare(b.stem))
    .map((s) => {
      const lo = Math.min(...s.numbers)
      const hi = Math.max(...s.numbers)
      return {
        nature: s.nature === 'invoice' ? 'Invoices for outward supply' as const : 'Credit Note' as const,
        from: s.names.get(lo)!, to: s.names.get(hi)!, total: s.numbers.length, cancelled: s.cancelled,
      }
    })
}

/* ------------------------------------------------------------ the files --- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-04-05" as the offline tool writes it: 05-Apr-2026. */
function toolDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}-${MONTHS[Number(m) - 1] ?? m}-${y}`
}

/** "33-Tamil Nadu", the way the templates name a place of supply. */
function place(code: string): string {
  const name = stateName(code)
  return name ? `${code}-${name}` : code
}

const amt = (m: number) => (m / 100).toFixed(2)
const pct = (bp: number) => String(bp / 100)

/**
 * Each non-empty section as a CSV with the column headings of the GSTN
 * offline tool's template, named for the section, ready to paste in.
 */
export function gstr1Files(g: Gstr1): { section: string; csv: string }[] {
  const files: { section: string; csv: string }[] = []
  const push = (section: string, headers: string[], rows: (string | number)[][]) => {
    if (rows.length > 0) files.push({ section, csv: toCsv(headers, rows) })
  }

  push('b2b', ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value',
    'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN',
    'Rate', 'Taxable Value', 'Cess Amount'],
  g.b2b.map((r) => [r.gstin, r.receiverName, r.invoiceNo, toolDate(r.invoiceDate), amt(r.invoiceValue),
    place(r.placeOfSupply), 'N', '', 'Regular B2B', '', pct(r.rateBp), amt(r.taxable), amt(r.cess)]))

  push('b2cl', ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate',
    'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
  g.b2cl.map((r) => [r.invoiceNo, toolDate(r.invoiceDate), amt(r.invoiceValue), place(r.placeOfSupply), '',
    pct(r.rateBp), amt(r.taxable), amt(r.cess), '']))

  push('b2cs', ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount',
    'E-Commerce GSTIN'],
  g.b2cs.map((r) => ['OE', place(r.placeOfSupply), '', pct(r.rateBp), amt(r.taxable), amt(r.cess), '']))

  push('cdnr', ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type',
    'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate',
    'Rate', 'Taxable Value', 'Cess Amount'],
  g.cdnr.map((r) => [r.gstin, r.receiverName, r.noteNo, toolDate(r.noteDate), 'C', place(r.placeOfSupply), 'N',
    'Regular B2B', amt(r.noteValue), '', pct(r.rateBp), amt(r.taxable), amt(r.cess)]))

  push('cdnur', ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value',
    'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
  g.cdnur.map((r) => ['B2CL', r.noteNo, toolDate(r.noteDate), 'C', place(r.placeOfSupply), amt(r.noteValue), '',
    pct(r.rateBp), amt(r.taxable), amt(r.cess)]))

  const hsnHeaders = ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value',
    'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount']
  const hsnRow = (r: HsnRow) => [r.hsn, r.description, r.uqc, (r.qty / 10_000).toString(), amt(r.value),
    pct(r.rateBp), amt(r.taxable), amt(r.igst), amt(r.cgst), amt(r.sgst), amt(r.cess)]
  push('hsn-b2b', hsnHeaders, g.hsnB2b.map(hsnRow))
  push('hsn-b2c', hsnHeaders, g.hsnB2c.map(hsnRow))

  push('docs', ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
    g.docs.map((r) => [r.nature, r.from, r.to, r.total, r.cancelled]))

  return files
}
