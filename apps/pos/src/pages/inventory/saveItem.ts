import {
  Money, Quantity, barcodesTaken, saveProductDetails, setBarcodes, setUnits, setProductCategory,
  type Features, type SqlDriver,
} from '@shopos/core'
import { belowCostMessage, retryBelowCost } from '../../ui/belowCost'
import type { Ask } from '../../ui/useConfirm'
import { saveBreaks } from './breaks'
import { saveUnitPrices } from './unitPrices'
import { levelOf, type Draft } from './draft'
import { stored } from './prices'

/** A message for the person saving, and whether it is good news. */
export type Say = (text: string, kind?: 'ok' | 'bad' | 'warn') => void

/**
 * Saves an item's page: its details through the core, then its barcodes,
 * units, box prices, quantity breaks and group, each through its own service.
 *
 * Moved out of the Inventory page whole when the item became a page of its
 * own; the order and every check are as they were. Returns the item's id, or
 * null when nothing was saved -- a refusal says why through `say`, in red.
 */
export async function saveItem({ db, actorId, draft, features, priceListId, ask, say }: {
  db: SqlDriver
  actorId: string
  draft: Draft
  features: Features
  priceListId: string
  ask: Ask
  say: Say
}): Promise<string | null> {
  if (draft.name.trim() === '') return null
  const refuse = (text: string) => { say(text, 'bad'); return null }

  /* Said, not assumed. A price typed as "12.3.4" used to save the item at
     ₹0, and a tax rate that was not a number saved it untaxed. */
  // Kept with GST, whichever side it was typed on (`inventory/prices.ts`).
  const rate = stored(draft, draft.baseRate, draft.rateSide, 'with') ?? Money.ZERO
  if (rate === 'bad') return refuse('The price is not an amount. Nothing was saved.')
  /* Null, not zero. A packet with no printed price is not a packet printed
     with ₹0, and the receipt only shows the MRP line when there is one. */
  const mrp = draft.mrp.trim() === '' ? null : Money.parseMoney(draft.mrp)
  if (mrp !== null && mrp < 0) return refuse('The MRP cannot be below zero. Nothing was saved.')
  if (draft.mrp.trim() !== '' && mrp === null) return refuse('The MRP is not an amount. Nothing was saved.')
  const cost = stored(draft, draft.costPrice, draft.costSide, 'before')
  if (cost === 'bad') return refuse('The cost price is not an amount. Nothing was saved.')
  // No GST is a rate of nothing and no cess, whatever the hidden boxes still hold.
  const percent = draft.noGst || draft.taxPercent.trim() === '' ? 0 : Number(draft.taxPercent)
  if (!Number.isFinite(percent)) return refuse('The tax rate is not a number. Nothing was saved.')
  const cessPercent = draft.noGst || draft.cessPercent.trim() === '' ? 0 : Number(draft.cessPercent)
  if (!Number.isFinite(cessPercent)) return refuse('The cess rate is not a number. Nothing was saved.')
  // One item per barcode (Settings, Features): asked before anything is written, so a refusal saves nothing.
  const taken = await barcodesTaken(db, draft.id, draft.barcodes.map((b) => b.barcode))
  if (taken.length > 0) return refuse(`${takenMessage(taken)} Nothing was saved.`)

  // Through the core, which checks the figures and writes the change to the
  // history. The barcode column is not written here: setBarcodes owns the pair
  // of products.barcode and the product_barcodes rows.
  const details = (allowBelowCost: boolean) => saveProductDetails(db, { actorId }, {
    id: draft.id,
    name: draft.name,
    brand: draft.brand,
    hsnCode: draft.hsnCode,
    taxRateBp: Math.round(percent * 100),
    cessRateBp: Math.round(cessPercent * 100),
    baseRate: rate,
    mrp,
    baseUnit: draft.baseUnit,
    discountBlocked: draft.discountBlocked,
    loyaltyBlocked: draft.loyaltyBlocked,
    returnBlocked: draft.returnBlocked,
    isStockTracked: draft.stockTracked,
    openPrice: draft.openPrice,
    costPrice: cost,
    reorderLevel: levelOf(draft.reorderLevel),
    reorderQty: levelOf(draft.reorderQty),
    ...(allowBelowCost ? { allowBelowCost } : {}),
  })
  // A selling rate below cost: see `ui/belowCost.ts`.
  const saved = await retryBelowCost(details, ask, (text) => say(text, 'bad'))
  if (saved === null) return null
  if (!saved.ok) {
    return refuse(
      saved.code === 'BELOW_COST' ? belowCostMessage(saved)
      : saved.code === 'BAD_TAX' ? 'GST is between 0 and 100 per cent, and cess between 0 and 300. Nothing was saved.'
      : saved.code === 'BAD_COST' ? 'The cost price cannot be below zero. Nothing was saved.'
      : saved.code === 'BAD_LEVEL' ? 'The reorder figures have to be quantities, zero or more. Nothing was saved.'
      : saved.code === 'UNKNOWN_PRODUCT' ? 'This item is no longer in the catalogue.'
      : 'The item could not be saved. Check its name and price.',
    )
  }
  const productId = saved.productId
  // A code another item has is saved too (069); the scan will ask which, and the owner is told so.
  const coded = await setBarcodes(db, { actorId }, productId, draft.barcodes)
  if (!coded.ok) { say(`The item was saved; its barcodes were not. ${takenMessage(coded.taken)}`, 'warn'); return productId }

  const units = await setUnits(db, { actorId }, productId, draft.units
    .filter((u) => u.saleUnit.trim() !== '')
    .map((u) => ({ saleUnit: u.saleUnit, baseUnits: Quantity.parseQty(u.baseUnits) ?? Quantity.qty(0) })))
  if (!units.ok) {
    say(
      units.code === 'IN_USE'
        ? `${units.saleUnit} is on ${units.billCount} bill(s) and cannot be removed. The rest was saved.`
        : units.code === 'CLASHES_WITH_BASE'
          ? `This item is already counted in ${units.saleUnit}. The rest was saved.`
          : units.code === 'WAS_THE_BASE'
          ? `${units.saleUnit} is what this item's unit used to be called, and still means one on older bills. Use another name. The rest was saved.`
          : `${units.saleUnit} needs how many ${draft.baseUnit} it holds. The rest was saved.`,
      'warn',
    )
    return productId
  }

  // Only with box prices on: off, the form shows none, and saving must not take any away.
  if (features.unitPrices && !(await saveUnitPrices(db, {
    actorId, productId, units: draft.units, ask, say: (text) => say(text, 'warn'),
  }))) return productId

  // Only with breaks on: off, the form shows none, and saving must not take any away.
  if (features.tieredPricing && priceListId && !(await saveBreaks(db, {
    actorId, productId, priceListId, unit: draft.baseUnit || 'piece', rows: draft.ladder, ask, say: (text) => say(text, 'warn'),
  }))) return productId

  await setProductCategory(db, { actorId }, productId, draft.categoryId || null)
  const { shared } = coded
  say(shared.length > 0
    ? `Saved. ${shared.map((s) => `${s.barcode} is also on ${s.productName}`).join('; ')} — scanning it will ask which item.`
    : 'Saved.', 'ok')
  return productId
}

/** A code refused because the shop holds each code to one item. */
export function takenMessage(taken: readonly { barcode: string; productName: string }[]): string {
  const which = taken.map((t) => `${t.barcode} is already on ${t.productName}`).join('; ')
  return `${which}. Each barcode is on one item only (Settings, Features).`
}
