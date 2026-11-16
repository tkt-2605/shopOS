import { parseMoney, type Money } from '../money.js'
import { parseQty, type Qty } from '../quantity.js'

/**
 * Reading one cell of a catalogue file (`services/import.ts`). Each reader
 * gives `null` for a blank cell -- which leaves the item's value alone -- and
 * `'bad'` for one that is not what its column says, which refuses the row.
 */

/** `null` for a blank cell, `'bad'` for one that is not a number. */
export function money(raw: string | undefined): Money | null | 'bad' {
  const text = (raw ?? '').trim()
  if (text === '') return null
  // A file from a wholesaler often carries the symbol and thousands commas.
  const cleaned = text.replace(/[₹,\s]/g, '')
  const value = parseMoney(cleaned)
  // A price below zero is not a price.
  return value === null || value < 0 ? 'bad' : value
}

/**
 * A tax percentage as basis points.
 *
 * `5`, `5%` and `5.0` are all five per cent. A number above 100 is refused
 * rather than clamped: somebody has typed basis points into a percent column,
 * and importing it as 2,800% tax would be visible only on the first bill.
 */
export function tax(raw: string | undefined): number | null | 'bad' {
  const text = (raw ?? '').trim().replace('%', '')
  if (text === '') return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 100) return 'bad'
  return Math.round(value * 100)
}

export function quantity(raw: string | undefined): Qty | null | 'bad' {
  const text = (raw ?? '').trim()
  if (text === '') return null
  const value = parseQty(text)
  // Opening stock is what is on the shelf, which is not below nothing.
  return value === null || value < 0 ? 'bad' : value
}
