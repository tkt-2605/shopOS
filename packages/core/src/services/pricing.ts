/**
 * Writing prices down.
 *
 * The reading half of this — the four-step chain that decides what a line costs —
 * has existed since v1 in `domain/pricing.ts` and is thoroughly tested. What was
 * missing was any way for a shop to put a price into it: the tables were filled
 * by the demo seed and by nothing else. A pricing engine a shopkeeper cannot
 * reach is not a feature, it is a claim.
 *
 * Everything here is the write side of tables `repos/pricing.ts` already reads,
 * in one file per thing a shop prices: `pricing/units.ts`, `pricing/lists.ts`,
 * `pricing/itemPrices.ts`, `pricing/customerPrices.ts` and `pricing/ladders.ts`.
 */

export { listUnits, perBaseUnit, setUnits } from './pricing/units.js'
export type { SaleUnit, SaleUnitInput, SetUnitsResult } from './pricing/units.js'
export {
  archivePriceList, createPriceList, listPriceLists, restorePriceList, updatePriceList,
} from './pricing/lists.js'
export type { ArchivePriceListResult, PriceList, PriceListResult } from './pricing/lists.js'
export { listItemPrices, removeItemPrice, setItemPrice } from './pricing/itemPrices.js'
export type { ItemPrice, ItemPriceInput, ItemPriceResult } from './pricing/itemPrices.js'
export {
  customerPriceListId, listCustomerPrices, removeCustomerPrice, setCustomerPrice, setCustomerPriceList,
  customersOnList,
} from './pricing/customerPrices.js'
export type { CustomerPrice } from './pricing/customerPrices.js'
export { customerLadderFor, ladderFor, laddersFor, setCustomerLadder, setLadder } from './pricing/ladders.js'
export type { SetLadderResult } from './pricing/ladders.js'
export { itemsPricedTwice, settleDoublePrice, pricesElsewhere } from './pricing/normalPrice.js'
export type { DoublePrice, SettleResult, PriceElsewhere } from './pricing/normalPrice.js'
export { exportLadders, planLadderImport, applyLadderImport, LADDER_COLUMNS } from './pricing/ladderCsv.js'
export type {
  LadderPlan, PlannedLadder, LadderTarget, LadderProblem, LadderRowProblem, LadderImportResult,
} from './pricing/ladderCsv.js'
