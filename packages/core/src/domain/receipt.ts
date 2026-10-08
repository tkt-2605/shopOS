/**
 * ESC/POS receipt for an 80mm thermal printer, Font A = 42 columns.
 *
 * The width and the two-line item layout are hardware facts, not preferences:
 * a 43rd character wraps and throws the whole column alignment out. Everything
 * here is padded to exactly 42.
 */

/*
 * The pieces, by what they do: `receipt/doc.ts` is the document itself,
 * `receipt/escpos.ts` the printer's codes and the column arithmetic,
 * `receipt/roll.ts` a bill laid out block by block, and `receipt/statement.ts`
 * a customer's account. This file is where every caller has always found them.
 */

export type {
  ReceiptShop, ReceiptItem, PlaceOfSupply, RateSummaryRow, ReceiptDoc,
} from './receipt/doc.js'
export { formatRate, rateSummaryOf, savingsOf } from './receipt/doc.js'

/**
 * The handful of words that differ between one kind of document and another.
 *
 * A quotation printed under "Invoice no." and "Billed to" says something untrue
 * about itself, and a purchase order says it twice over — the party named on it
 * is the supplier, and the shop is the one that will be billed. This travels
 * with the document and not with the format, because the shop chooses its
 * format and does not get to choose what a purchase order is.
 */
/* Declared in `wording.ts` and re-exported here, where every caller already
   looks for them. See that file for why they had to leave this one. */
export type { DocWording } from './wording.js'
export { BILL_WORDING } from './wording.js'

export { buildReceipt } from './receipt/roll.js'
export {
  rasterize, rasterCommand, readRaster, rollDots, logoDots, isBlank, toBytes, DOTS_PER_MM, LOGO_DEFAULT_MM, LOGO_MAX_MM,
} from './receipt/raster.js'
export type { Raster } from './receipt/raster.js'
export { WIDTH, forThermal, smallColumns, previewLines, visibleLines, signed } from './receipt/escpos.js'
export type { PreviewAlign, PreviewLine } from './receipt/escpos.js'
export { buildStatement } from './receipt/statement.js'
export type { StatementLine, StatementDoc } from './receipt/statement.js'
