/**
 * Reading and writing CSV, for a file a shopkeeper made in Excel.
 *
 * The writer has existed since the first export. The reader is new, and it is
 * the harder half: a file this product is handed was not produced by this
 * product. It came out of Excel, or Tally, or a wholesaler's portal, and every
 * one of them has its own idea of what CSV is.
 *
 * What that means in practice, and why each is handled here rather than being
 * somebody's surprise later:
 *
 * - **A quoted field can contain a comma, a quote, or a newline.** A product
 *   called `Rice, 5kg` is one field, and a naive `split(',')` turns a
 *   catalogue into rubbish silently.
 * - **`""` inside quotes is one quote.** That is the escape, not a backslash.
 * - **Line endings are CRLF, LF, or a mixture.** A file edited on two machines
 *   has both.
 * - **Excel writes a UTF-8 BOM**, which becomes an invisible character on the
 *   front of the first header. The symptom is a column called `name` that does
 *   not match the column called `name`.
 * - **A trailing newline is not an empty row.** Almost every writer emits one,
 *   and counting it as a row means every import reports one more line than the
 *   file has and fails on a blank.
 *
 * Deliberately not a dependency. This is ninety lines, a CSV library is a
 * supply-chain risk for a product that already refuses to fetch from the
 * webview, and the failure modes above are the entire specification.
 */

/** A UTF-8 byte-order mark, as one character once decoded. */
const BOM = '\u{FEFF}'

/**
 * Every row, as arrays of raw strings. Nothing is trimmed and nothing is
 * interpreted -- a leading zero on a barcode is data, and so is a space.
 */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith(BOM) ? text.slice(1) : text
  const rows: string[][] = []

  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  /* A hand-written state machine rather than a regex, because the thing that
     makes CSV awkward -- a newline inside quotes -- is exactly what a regex
     over lines cannot see. */
  while (i < input.length) {
    const c = input[i] as string

    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }

    if (c === '"' && field === '') { quoted = true; i += 1; continue }

    if (c === ',') { row.push(field); field = ''; i += 1; continue }

    if (c === '\r' || c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      // CRLF is one ending, not two.
      i += c === '\r' && input[i + 1] === '\n' ? 2 : 1
      continue
    }

    field += c
    i += 1
  }

  /* The last row only exists if the file did not end on a newline. Pushing it
     unconditionally is how a trailing newline becomes a phantom blank row at
     the end of every import. */
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/**
 * The same rows keyed by header, which is what a caller actually wants.
 *
 * Headers are lower-cased and stripped of spaces and underscores, so
 * `Tax %`, `tax_%` and `TAX%` are one column. A shopkeeper who typed a header
 * with a capital letter has not made a mistake.
 *
 * Short rows are padded rather than refused: Excel truncates trailing empty
 * cells, so a row whose last two columns are blank arrives with two fewer
 * fields than the header, and that is not an error.
 */
export interface CsvRecord {
  /**
   * The line in the file, 1-based and counting the header — so it is the
   * number Excel puts down the left-hand side.
   *
   * Carried rather than recomputed from the position in `rows`, because blank
   * lines are dropped: a file with a gap in the middle would otherwise report
   * every later problem against a line one too early, and somebody would go
   * and look at a row that was fine.
   */
  line: number
  values: Record<string, string>
}

export function parseCsvRecords(text: string): {
  headers: string[]
  rows: CsvRecord[]
} {
  const table = parseCsv(text)
  const first = table[0]
  if (first === undefined) return { headers: [], rows: [] }

  const headers = first.map(normaliseHeader)
  const rows: CsvRecord[] = []

  table.slice(1).forEach((cells, at) => {
    // A wholly blank line in the middle of a file is not a record.
    if (!cells.some((c) => c.trim() !== '')) return

    const values: Record<string, string> = {}
    headers.forEach((header, column) => { values[header] = cells[column] ?? '' })
    rows.push({ line: at + 2, values })
  })

  return { headers, rows }
}

/** `Tax %` and `tax_%` are the same column. */
export function normaliseHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '')
}

/**
 * Rows out, as a file Excel will open without complaining.
 *
 * CRLF because that is what Excel expects, and a trailing one because every
 * other writer emits it -- `parseCsv` above treats it as an ending rather than
 * a row, which is the pair of decisions that lets a file survive a round trip
 * through this product.
 */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (v: string | number): string => {
    const s = String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n') + '\r\n'
}
