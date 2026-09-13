import { type Money, parseMoney } from '../money.js'
import { type Qty, parseQty, formatQty } from '../quantity.js'

/**
 * A quantity ladder: buy this many or more, pay this each.
 *
 * "One is ten rupees, ten or more is nine, fifty or more is eight" — three
 * rungs. The rows in `item_prices` are the record; this is the shape a screen
 * edits them in, and the rule for whether what has been typed makes sense.
 *
 * That rule lives here rather than on the screen because it decides whether a
 * shop's prices are valid, which is something that should be wrong in a test
 * rather than at a counter.
 */

export interface Rung {
  /** Buy this many or more and the rate below applies. */
  minQty: Qty
  rate: Money
}

/**
 * One rung as it is being typed.
 *
 * Text, not numbers: a half-typed "1" on the way to "10" must not be read as a
 * rung of one and reprice the shelf while somebody is still typing.
 */
export interface LadderRow {
  minQty: string
  rate: string
}

export type RowsResult =
  | { ok: true; rungs: Rung[] }
  | { ok: false; code: 'BAD_QTY' | 'BAD_RATE' | 'HALF_ROW' | 'REPEATED_QTY'; index: number }

/** A row with neither box filled is somebody who changed their mind, not an error. */
function isBlank(row: LadderRow): boolean {
  return row.minQty.trim() === '' && row.rate.trim() === ''
}

/**
 * What the rows mean, or the first thing wrong with them.
 *
 * Strict about a half-filled row. A quantity with no price beside it is a rung
 * that would otherwise be dropped in silence, and a ladder quietly missing a
 * rung sells at the wrong price all week with nothing on screen to say so.
 */
export function rowsToRungs(rows: LadderRow[]): RowsResult {
  const rungs: Rung[] = []
  const seen = new Set<number>()

  for (const [index, row] of rows.entries()) {
    if (isBlank(row)) continue
    if (row.minQty.trim() === '' || row.rate.trim() === '') {
      return { ok: false, code: 'HALF_ROW', index }
    }

    const minQty = parseQty(row.minQty.trim())
    if (minQty === null || minQty < 0) return { ok: false, code: 'BAD_QTY', index }

    const rate = parseMoney(row.rate.trim())
    if (rate === null || rate < 0) return { ok: false, code: 'BAD_RATE', index }

    // Two prices for the same quantity has no answer.
    if (seen.has(minQty)) return { ok: false, code: 'REPEATED_QTY', index }
    seen.add(minQty)
    rungs.push({ minQty, rate })
  }

  // Typed in any order, kept in the order they apply.
  rungs.sort((a, b) => a.minQty - b.minQty)
  return { ok: true, rungs }
}

/** Back into the boxes they are edited in. */
export function rungsToRows(rungs: Rung[]): LadderRow[] {
  return [...rungs]
    .sort((a, b) => a.minQty - b.minQty)
    .map((r) => ({ minQty: formatQty(r.minQty), rate: plainRupees(r.rate) }))
}

/**
 * Plain rupees, ungrouped and without `.00` on a whole one.
 *
 * `Money.format` groups in the Indian style, so ₹1,200 would come back into the
 * box as `1,200.00` and read as something other than a number.
 */
function plainRupees(m: Money): string {
  const rupees = m / 100
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2)
}

/** The one-line form for a column: `1=₹10 · 10=₹9 · 50=₹8`. */
export function describeLadder(rungs: Rung[]): string {
  return [...rungs]
    .sort((a, b) => a.minQty - b.minQty)
    .map((r) => `${formatQty(r.minQty)}=₹${plainRupees(r.rate)}`)
    .join(' · ')
}

/**
 * Whether a ladder ever charges more for buying more, which is almost always a
 * typo — 90 where 9 was meant. Worth saying out loud rather than refusing: a
 * shop may genuinely price a single loose unit above a sealed box.
 */
export function risingRungs(rungs: Rung[]): Rung[] {
  const sorted = [...rungs].sort((a, b) => a.minQty - b.minQty)
  const rising: Rung[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.rate > sorted[i - 1]!.rate) rising.push(sorted[i]!)
  }
  return rising
}
