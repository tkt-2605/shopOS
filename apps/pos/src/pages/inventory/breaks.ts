import { Ladder, Quantity, setLadder, type SqlDriver } from '@shopos/core'
import { belowCostMessage, retryBelowCost } from '../../ui/belowCost'
import { describeRowsProblem, type LadderRow } from '../../ui/LadderEditor'
import type { useConfirm } from '../../ui/useConfirm'

/*
 * An item's own quantity breaks, saved from its form.
 *
 * The selling rate is the price of one, so the breaks are only the rungs above
 * it: "from 10, ₹9". They live on the shop's own list, where the counter has
 * always read them (`domain/pricing.ts`), but that list is never shown as a
 * list -- it is the item's, and the item is where it is set.
 */

/** The breaks above the price of one, as the form edits them. */
export function breakRows(rungs: Ladder.Rung[]): LadderRow[] {
  return Ladder.rungsToRows(rungs.filter((r) => r.minQty > Quantity.QTY_SCALE))
}

/**
 * Writes the breaks typed, replacing whatever the item had above its selling
 * rate. False when what was typed cannot be read, and nothing was written.
 */
export async function saveBreaks(
  db: SqlDriver,
  input: {
    actorId: string; productId: string; priceListId: string; unit: string; rows: LadderRow[]
    ask: ReturnType<typeof useConfirm>[1]; say: (message: string) => void
  },
): Promise<boolean> {
  const parsed = Ladder.rowsToRungs(input.rows)
  if (!parsed.ok) {
    input.say(describeRowsProblem(parsed, input.unit) ?? 'The prices need checking.')
    return false
  }
  if (parsed.rungs.some((r) => r.minQty <= Quantity.QTY_SCALE)) {
    input.say(`A break starts above 1 ${input.unit}: the price of one is the selling rate. Nothing was saved.`)
    return false
  }
  const write = (allowBelowCost: boolean) => setLadder(db, { actorId: input.actorId }, {
    productId: input.productId, priceListId: input.priceListId, saleUnit: input.unit, rungs: parsed.rungs,
    ...(allowBelowCost ? { allowBelowCost } : {}),
  })
  const written = await retryBelowCost(write, input.ask, input.say)
  if (written !== null && !written.ok) {
    // A refused ladder leaves the old one as it was: every rung is asked before any is written.
    input.say(written.code === 'BELOW_COST'
      ? `The item was saved; its quantity breaks were not. ${belowCostMessage(written)}`
      : 'The quantity breaks could not be saved against this item.')
  }
  return true
}
