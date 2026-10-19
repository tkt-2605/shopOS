import { Money, type BelowCostRefusal, type UnderCost } from '@shopos/core'
import type { Ask } from './useConfirm'

/*
 * What every screen says when core refuses a price or a sale below cost
 * (`services/belowCost.ts`), in one place: the counter, the item, the price
 * lists and Stock In word it the same way, and ask the same question of the
 * one person who may answer it.
 */

/** "Pen at ₹70.00 a piece, cost ₹80.00", for each line, joined. */
export function belowCostLines(lines: readonly UnderCost[]): string {
  return lines
    .map((l) => `${l.name} at ₹${Money.format(l.sellsAt)}, cost ₹${Money.format(l.cost)}`)
    .join('; ')
}

/** The sentence for somebody who may not go ahead. */
export function belowCostMessage(refusal: BelowCostRefusal): string {
  return `Below cost: ${belowCostLines(refusal.lines)} (before GST, per unit). `
    + 'Only someone allowed to sell below cost can go ahead.'
}

/**
 * A save that core may refuse below cost, tried, and tried again with the
 * person's yes if they may give one. Null when it was refused and not retried:
 * somebody who may not go ahead has been told why through `say`, somebody who
 * may has said no. Anything else -- done, or refused for another reason -- is
 * the caller's to read as before.
 */
export async function retryBelowCost<R extends { ok: boolean }>(
  attempt: (allowBelowCost: boolean) => Promise<R>, ask: Ask, say: (message: string) => void,
): Promise<R | null> {
  const first = await attempt(false)
  const refused = first as unknown as Partial<BelowCostRefusal>
  if (first.ok || refused.code !== 'BELOW_COST') return first
  return (await allowBelowCost(refused as BelowCostRefusal, ask, say)) ? attempt(true) : null
}

/**
 * True when this person may go below cost and says yes. Anyone else is told
 * why through `say`, and gets false.
 */
export async function allowBelowCost(
  refusal: BelowCostRefusal, ask: Ask, say: (message: string) => void,
): Promise<boolean> {
  if (!refusal.mayAllow) {
    say(belowCostMessage(refusal))
    return false
  }
  return ask({
    title: 'Below cost',
    message: `${belowCostLines(refusal.lines)}, before GST, per unit. Go ahead anyway? It is recorded in the audit log.`,
    confirmLabel: 'Go ahead below cost',
  })
}
