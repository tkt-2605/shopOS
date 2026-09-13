import { type Money, parseMoney } from '../money.js'
import { type Qty, parseQty, formatQty } from '../quantity.js'

/**
 * A quantity ladder, written the way a shopkeeper says it.
 *
 * "One is ten rupees, ten is nine, fifty is eight" — `1=10, 10=9, 50=8`. The
 * same thing the Prices screen holds as three rows, in a form that can be typed
 * in one go against a product and read back at a glance in a list.
 *
 * The rows are the record; this is a way of writing them. Nothing here touches
 * the database, so the parsing can be wrong in a test rather than in a shop.
 */

export interface Rung {
  /** Buy this many or more and the rate below applies. */
  minQty: Qty
  rate: Money
}

export type LadderResult =
  | { ok: true; rungs: Rung[] }
  | { ok: false; code: 'BAD_PART'; part: string }
  | { ok: false; code: 'BAD_QTY'; part: string }
  | { ok: false; code: 'BAD_RATE'; part: string }
  | { ok: false; code: 'REPEATED_QTY'; part: string }

/**
 * Reads `1=10, 10=9, 50=8`.
 *
 * Forgiving about how it is written, because it is typed at a counter: commas,
 * semicolons or new lines between the rungs; `=`, `@` or `:` between the two
 * numbers; rupee signs and "rs" ignored. Strict about what it means — a rung
 * that cannot be read is an error rather than a silent omission, since a ladder
 * quietly missing its top rung sells at the wrong price all week.
 */
export function parseLadder(text: string): LadderResult {
  const parts = text.split(/[,;\n]+/).map((p) => p.trim()).filter((p) => p !== '')
  const rungs: Rung[] = []
  const seen = new Set<number>()

  for (const part of parts) {
    const match = part.match(/^(.+?)\s*[=@:]\s*(.+)$/)
    if (!match) return { ok: false, code: 'BAD_PART', part }

    const quantity = parseQty(clean(match[1]!))
    if (quantity === null || quantity < 0) return { ok: false, code: 'BAD_QTY', part }

    const rate = parseMoney(clean(match[2]!))
    if (rate === null || rate < 0) return { ok: false, code: 'BAD_RATE', part }

    if (seen.has(quantity)) return { ok: false, code: 'REPEATED_QTY', part }
    seen.add(quantity)
    rungs.push({ minQty: quantity, rate })
  }

  // Read in whatever order it was typed, kept in the order it applies.
  rungs.sort((a, b) => a.minQty - b.minQty)
  return { ok: true, rungs }
}

function clean(raw: string): string {
  return raw.replace(/[₹]/g, '').replace(/\brs\.?/gi, '').replace(/\s+/g, '').trim()
}

/**
 * Plain rupees, ungrouped.
 *
 * `Money.format` groups in the Indian style — a ₹1,200 rung would come back as
 * `1=1,200.00`, and the comma is what separates one rung from the next, so the
 * ladder would read as two. Whole rupees lose their `.00` as well: this is a box
 * a shopkeeper types into and reads back.
 */
function plainRupees(m: Money): string {
  const rupees = m / 100
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2)
}

/** Back to `1=10, 10=9, 50=8`, for putting in the box that was typed into. */
export function formatLadder(rungs: Rung[]): string {
  return [...rungs]
    .sort((a, b) => a.minQty - b.minQty)
    .map((r) => `${formatQty(r.minQty)}=${plainRupees(r.rate)}`)
    .join(', ')
}

/** The one-line form for a column: `1=₹10 · 10=₹9 · 50=₹8`. */
export function describeLadder(rungs: Rung[]): string {
  return [...rungs]
    .sort((a, b) => a.minQty - b.minQty)
    .map((r) => `${formatQty(r.minQty)}=₹${plainRupees(r.rate)}`)
    .join(' · ')
}

/**
 * What the ladder charges for a quantity — the same rule the resolver uses, so a
 * screen can show the effect of a ladder without going to the database.
 *
 * The highest rung at or below the quantity wins. Below the lowest rung there is
 * no answer here: that is the item's base rate, which this module does not know.
 */
export function rateFor(rungs: Rung[], quantity: Qty): Money | null {
  let best: Rung | null = null
  for (const rung of rungs) {
    if (quantity >= rung.minQty && (best === null || rung.minQty > best.minQty)) best = rung
  }
  return best?.rate ?? null
}

/**
 * Whether a ladder ever charges more for buying more, which is almost always a
 * typo — `1=10, 10=90` rather than `10=9`. Worth saying out loud rather than
 * refusing: a shop may genuinely price a single loose unit below a sealed box.
 */
export function risingRungs(rungs: Rung[]): Rung[] {
  const sorted = [...rungs].sort((a, b) => a.minQty - b.minQty)
  const rising: Rung[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.rate > sorted[i - 1]!.rate) rising.push(sorted[i]!)
  }
  return rising
}
