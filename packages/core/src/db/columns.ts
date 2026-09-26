import { customType } from 'drizzle-orm/sqlite-core'
import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'

/**
 * The two column types that carry a brand.
 *
 * SQLite stores both as integers and there is nothing in the file to tell them
 * apart: `rate` is paise, `qty` is units times ten thousand, `tax_rate_bp` is
 * basis points, and `points` is points. Read as plain numbers they add up
 * without complaint and the answer is wrong by a factor of a hundred or ten
 * thousand, which is exactly the class of bug branded `Money` and `Qty` exist
 * to make unwriteable in the rest of the codebase.
 *
 * Hand-written SQL returns `number`, so every repo has had to re-apply the
 * brand on the way out — `qty(r.base_units)`, `paise(row.grand_total)` — and a
 * column somebody forgot to wrap was a plain number the compiler was happy
 * with. A typed query knows what the column is, so the brand comes back with
 * the row and the mistake stops being available.
 *
 * `fromDriver`/`toDriver` are casts and not conversions. The scale is what is
 * in the database already; this is about the type, not the value. Validating
 * here (`paise()`, `qty()`) would throw on rows that are already in a shop's
 * database, in a read — turning a data problem into a till that will not open a
 * screen. The place to refuse a bad number is where one is being made.
 */

export const money = customType<{ data: Money; driverData: number }>({
  dataType: () => 'integer',
  fromDriver: (value) => value as Money,
  toDriver: (value) => value,
})

export const qtyCol = customType<{ data: Qty; driverData: number }>({
  dataType: () => 'integer',
  fromDriver: (value) => value as Qty,
  toDriver: (value) => value,
})
