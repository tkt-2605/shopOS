import { Money, Quantity, setUnitPrices, type SaleUnit, type SqlDriver, type UnitPrice, type UnitPriceInput } from '@shopos/core'
import { belowCostMessage, retryBelowCost } from '../../ui/belowCost'
import type { useConfirm } from '../../ui/useConfirm'
import type { UnitDraft } from './draft'

/*
 * A box's own MRP and price, on its unit row (079).
 *
 * Shown and saved only with "Box prices and MRP" on in Settings. Off, the form
 * does not touch them: a box price saved before stays where it is, uncharged,
 * for when the switch comes back on.
 */

/** The unit rows as the form edits them, with what each is printed and sold at. */
export function unitDrafts(units: SaleUnit[], prices: UnitPrice[]): UnitDraft[] {
  const byUnit = new Map(prices.map((p) => [p.saleUnit, p]))
  return units.map((u) => {
    const priced = byUnit.get(u.saleUnit)
    return {
      saleUnit: u.saleUnit,
      baseUnits: Quantity.formatQty(u.baseUnits),
      mrp: priced?.mrp == null ? '' : Money.format(priced.mrp),
      rate: priced?.rate == null ? '' : Money.format(priced.rate),
      asPieces: priced ? Money.format(priced.asPieces) : '',
    }
  })
}

/** Blank is none; anything else has to be an amount. */
function amountOf(text: string | undefined): Money.Money | null | 'bad' {
  const typed = (text ?? '').trim()
  if (typed === '') return null
  const value = Money.parseMoney(typed)
  return value === null || value < 0 ? 'bad' : value
}

/**
 * Writes each unit's MRP and price. False when something was refused and the
 * person has been told; the rest of the item is already saved by then.
 */
export async function saveUnitPrices(
  db: SqlDriver,
  input: {
    actorId: string; productId: string; units: UnitDraft[]
    ask: ReturnType<typeof useConfirm>[1]; say: (message: string) => void
  },
): Promise<boolean> {
  const units: UnitPriceInput[] = []
  for (const u of input.units.filter((x) => x.saleUnit.trim() !== '')) {
    const mrp = amountOf(u.mrp)
    const rate = amountOf(u.rate)
    if (mrp === 'bad' || rate === 'bad') {
      input.say(`The ${u.saleUnit.trim()} MRP and price have to be amounts. The rest of the item was saved.`)
      return false
    }
    units.push({ saleUnit: u.saleUnit.trim(), mrp, rate })
  }
  if (units.length === 0) return true

  const write = (allowBelowCost: boolean) => setUnitPrices(db, { actorId: input.actorId }, {
    productId: input.productId, units, ...(allowBelowCost ? { allowBelowCost } : {}),
  })
  const saved = await retryBelowCost(write, input.ask, input.say)
  if (saved === null) return false
  if (saved.ok) return true
  const rupees = (m: Money.Money) => `₹${Money.format(m)}`
  input.say(
    saved.code === 'ABOVE_MRP'
      ? `A ${saved.saleUnit} is printed ${rupees(saved.mrp)}, so it cannot sell at ${rupees(saved.rate)}. Its MRP and price were not saved; the rest of the item was.`
      : saved.code === 'PIECES_ABOVE_MRP'
        ? `A ${saved.saleUnit} is printed ${rupees(saved.mrp)}, but as its pieces it comes to ${rupees(saved.rate)}. Give the ${saved.saleUnit} a price at or under its MRP. The rest of the item was saved.`
        : saved.code === 'BELOW_COST'
          ? `The item was saved; its ${units.map((u) => u.saleUnit).join(' and ')} price was not. ${belowCostMessage(saved)}`
          : `The ${saved.saleUnit} MRP and price could not be saved. The rest of the item was.`,
  )
  return false
}
