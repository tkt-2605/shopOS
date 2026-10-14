import { REPLICATED, type SqlDriver } from '@shopos/core'

/**
 * What a till holds, and whether several tills hold the same.
 *
 * Shared by the in-process scenarios (`test/shop.ts`) and the soak that runs
 * tills in separate processes and namespaces (`compare.ts`), so the two cannot
 * come to mean different things by "converged".
 */

export type Row = Record<string, unknown>
/** Table, then row id, then the row. */
export type Held = Map<string, Map<string, Row>>

/**
 * What one till holds, on every table that is supposed to travel.
 *
 * Whole rows, not counts. A count says two tills have the same number of
 * products, which is the assertion a broken merge passes: the tiebreak went one
 * way here and the other way there, both tills hold one row, and they disagree
 * about what is in it.
 */
export async function contents(db: SqlDriver): Promise<Held> {
  const held: Held = new Map()
  for (const shape of REPLICATED) {
    held.set(shape.table, await dump(db, shape.table, shape.key))
    for (const line of shape.lines) held.set(line.table, await dump(db, line.table, null))
  }
  return held
}

/**
 * Rows by the thing that identifies them.
 *
 * The line tables do not all have one — `role_permissions` is keyed by the
 * pair — so a row with no `id` is identified by everything in it except the
 * three columns below. That is enough to line two tills' copies up, which is
 * all this needs to do.
 */
async function dump(db: SqlDriver, table: string, key: string | null): Promise<Map<string, Row>> {
  // raw: the table comes from `REPLICATED`, and is not known until run time.
  const rows = await db.query<Row>(`SELECT * FROM "${table}"`)
  const held = new Map<string, Row>()
  for (const row of rows) {
    const id = key !== null && key in row ? String(row[key])
      : 'id' in row ? String(row['id'])
        : bare(row)
    held.set(id, row)
  }
  return held
}

/** For carrying a till's books across a process boundary, and back. */
export function heldToJson(held: Held): Record<string, Record<string, Row>> {
  const out: Record<string, Record<string, Row>> = {}
  for (const [table, rows] of held) out[table] = Object.fromEntries(rows)
  return out
}

export function heldFromJson(json: Record<string, Record<string, Row>>): Held {
  return new Map(Object.entries(json).map(([table, rows]) => [table, new Map(Object.entries(rows))]))
}

/**
 * When a row was written and how many times, which is the one thing two tills
 * may hold differently without having failed to converge — but only for the
 * seeded rows. See `disagreementsBetween`.
 */
const PROVENANCE = new Set(['created_at', 'updated_at', 'rev'])

function bare(row: Row): string {
  return Object.keys(row).sort()
    .filter((c) => !PROVENANCE.has(c))
    .map((c) => `${c}=${String(row[c])}`)
    .join('')
}

export interface Disagreement {
  table: string
  rowId: string
  /** The till that differs from the first, and what it holds instead. */
  till: string
  detail: string
}

/**
 * Every row on which some till holds something the first one does not.
 *
 * `rev` and `updated_at` are compared like any other column, and deliberately:
 * they are what the *next* merge will compare, so two tills agreeing on a price
 * while disagreeing about its revision have not converged — they have arranged
 * to diverge later.
 *
 * The exception is `seeded`: rows a migration wrote, which every till writes
 * for itself at upgrade time and which are deliberately kept out of the feed.
 * `029_document_says_what_it_is.sql` carries the argument. Their *contents*
 * are still compared, so a migration that lands differently on two tills fails
 * here.
 */
export function disagreementsBetween(
  tills: ReadonlyArray<{ label: string; held: Held }>,
  seeded: ReadonlyMap<string, ReadonlySet<string>>,
): Disagreement[] {
  const [first, ...others] = tills
  if (first === undefined) return []
  const found: Disagreement[] = []
  for (const other of others) {
    for (const [table, mine] of first.held) {
      const yours = other.held.get(table) ?? new Map<string, Row>()
      const seededHere = seeded.get(table) ?? new Set<string>()
      for (const id of new Set([...mine.keys(), ...yours.keys()])) {
        const a = mine.get(id)
        const b = yours.get(id)
        if (a === undefined || b === undefined) {
          found.push({
            table, rowId: id, till: other.label,
            detail: a === undefined ? `${first.label} does not have it` : 'they do not have it',
          })
          continue
        }
        const differs = seededHere.has(id)
          ? (bare(a) === bare(b) ? null : 'contents')
          : firstDifferingColumn(a, b)
        if (differs !== null) {
          found.push({
            table, rowId: id, till: other.label,
            detail: `${differs}: ${first.label} has ${String(a[differs] ?? bare(a))}, they have ${String(b[differs] ?? bare(b))}`,
          })
        }
      }
    }
  }
  return found
}

function firstDifferingColumn(a: Row, b: Row): string | null {
  for (const column of Object.keys(a).sort()) {
    if (String(a[column]) !== String(b[column])) return column
  }
  return null
}

/** The books of one till, checked against themselves. */
export interface Health {
  /** Rows a merge could not land and set aside. Each is data not where it should be. */
  quarantined: number
  /** Edits the merge decided between. Not wrong in itself; said so a person can look. */
  conflicts: number
  /** Vouchers whose ledger lines do not balance. Must be none. */
  unbalancedVouchers: number
  /** Products whose stock on hand is not what the stock ledger adds up to. Must be none. */
  stockAdrift: number
  /** Bill numbers missing from a counter's series, e.g. `MR/2627/00007`. Must be none. */
  missingNumbers: string[]
  bills: number
}

export async function health(db: SqlDriver): Promise<Health> {
  const count = async (sql: string): Promise<number> =>
    (await db.get<{ n: number }>(sql))?.n ?? 0

  const quarantined = await count(`SELECT COUNT(*) AS n FROM sync_quarantine`)
  const conflicts = await count(`SELECT COUNT(*) AS n FROM sync_conflicts`)
  // raw: a grouped HAVING over every voucher, which is the check itself.
  const unbalancedVouchers = await count(
    `SELECT COUNT(*) AS n FROM (
       SELECT voucher_type, voucher_id FROM gl_entries
       GROUP BY voucher_type, voucher_id HAVING SUM(debit) <> SUM(credit))`,
  )
  // raw: the cache against the ledger it is derived from, product by product.
  const stockAdrift = await count(
    `SELECT COUNT(*) AS n FROM product_stock ps
       WHERE ps.qty_on_hand <> COALESCE(
         (SELECT SUM(qty_change) FROM stock_ledger sl WHERE sl.product_id = ps.product_id), 0)`,
  )

  /* A gap in a counter's series is a number issued and lost, or never issued
     -- either way a hole an auditor asks about, and under GST a series runs
     without one. Read off the numbers themselves: `MR/2627/00007`. */
  const numbers = await db.query<{ doc_no: string }>(`SELECT doc_no FROM bills`)
  const series = new Map<string, number[]>()
  for (const { doc_no } of numbers) {
    const cut = doc_no.lastIndexOf('/')
    const stem = doc_no.slice(0, cut + 1)
    const n = Number(doc_no.slice(cut + 1))
    if (!Number.isInteger(n)) continue
    series.set(stem, [...(series.get(stem) ?? []), n])
  }
  const missingNumbers: string[] = []
  for (const [stem, ns] of series) {
    const have = new Set(ns)
    for (let n = 1; n <= Math.max(...ns); n += 1) {
      if (!have.has(n)) missingNumbers.push(`${stem}${String(n).padStart(5, '0')}`)
    }
  }

  return {
    quarantined, conflicts, unbalancedVouchers, stockAdrift, missingNumbers,
    bills: numbers.length,
  }
}
