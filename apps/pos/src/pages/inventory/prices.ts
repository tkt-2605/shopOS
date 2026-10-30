import { Money, Tax } from '@shopos/core'
import { bpOf, pairOf, type Side } from '../../ui/gstPair'
import type { Draft } from './draft'

/*
 * An item's selling rate and cost price, each typed before GST or with it.
 *
 * Kept as stored: the selling rate with GST, the cost price before it (074).
 * What the form holds is the text as typed and which side it was typed on, so
 * an item opened and saved untouched writes back exactly what it had: a rate
 * taken apart to paise before GST and put back together can land a paisa away
 * from where it started, and nobody asked for that paisa. Only a box somebody
 * typed in is converted, and only on save.
 */

/** GST and cess on this draft, in basis points. No GST is nothing of either. */
export function draftTax(draft: Draft): { rateBp: number; cessBp: number } {
  return draft.noGst ? { rateBp: 0, cessBp: 0 } : { rateBp: bpOf(draft.taxPercent), cessBp: bpOf(draft.cessPercent) }
}

/** What the box shows on the side the switch is on. */
export function shown(draft: Draft, text: string, typedOn: Side, mode: Side): string {
  if (typedOn === mode || text.trim() === '') return text
  const { rateBp, cessBp } = draftTax(draft)
  return pairOf(text, typedOn, rateBp, cessBp)[mode]
}

/** The same amount said the other way, for the line under the box; null when there is nothing to say. */
export function otherSide(draft: Draft, text: string, typedOn: Side, mode: Side): string | null {
  const { rateBp, cessBp } = draftTax(draft)
  if (rateBp === 0 && cessBp === 0) return null
  const other: Side = mode === 'with' ? 'before' : 'with'
  const figure = shown(draft, text, typedOn, other)
  if (figure.trim() === '' || Money.parseMoney(figure) === null) return null
  return `₹${figure} ${other === 'with' ? 'with GST' : 'before GST'}`
}

/**
 * A kept cost, which is before GST, said on the side the list's switch is on:
 * with the item's own GST and cess added for 'with'. A rate past what GST
 * allows shows the cost as kept rather than a wrong figure.
 */
export function costOn(cost: Money.Money, rateBp: number, cessBp: number, mode: Side): Money.Money {
  if (mode === 'before') return cost
  try {
    return (cost + Tax.addTax(cost, rateBp, 'intra_state', cessBp).taxTotal) as Money.Money
  } catch {
    return cost
  }
}

/**
 * The amount as it is kept, on the side `want`: null for a blank box, 'bad'
 * for something that is not an amount or is below zero.
 */
export function stored(draft: Draft, text: string, typedOn: Side, want: Side): Money.Money | null | 'bad' {
  if (text.trim() === '') return null
  const value = Money.parseMoney(text)
  if (value === null || value < 0) return 'bad'
  if (typedOn === want) return value
  const { rateBp, cessBp } = draftTax(draft)
  try {
    return want === 'with'
      ? (value + Tax.addTax(value, rateBp, 'intra_state', cessBp).taxTotal) as Money.Money
      : Tax.splitTax(value, rateBp, 'intra_state', cessBp).taxableValue
  } catch {
    return 'bad'
  }
}
