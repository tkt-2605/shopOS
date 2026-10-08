import { type Qty, QTY_ZERO, addQty, subQty } from '../quantity.js'
import { addDays } from '../dates.js'
import type { Money } from '../money.js'

/**
 * Batches and the days they expire. Pure: no database, no clock.
 *
 * A batch is a quantity of one product made together, carrying one number and
 * one expiry date. The stock ledger says how much of a product there is; this
 * says which batches it is made of. Whatever the ledger holds that no batch
 * accounts for is "unbatched" -- stock received before the shop switched the
 * feature on, or received without a number -- and is a normal state, not an
 * error.
 */

/** The longest batch number a pack plausibly prints. The column refuses more. */
export const BATCH_NO_MAX = 40

/**
 * The pick that means "the stock without a batch", as against no pick at all.
 *
 * Once an item's new delivery comes in as a batch with its own price, the
 * packs already on the shelf -- received before, with no batch -- are the old
 * price. A cashier who sells one of those must have it come out of that stock,
 * not out of the new batch that soonest-expiry-first would reach for.
 */
export const UNBATCHED_PICK = 'unbatched'

/** How far ahead "expiring soon" looks. Three months is what a chemist returns to a distributor against. */
export const EXPIRY_SOON_DAYS = 90

/**
 * A batch number as it is stored and compared.
 *
 * Upper case with single spaces, because the same number is typed by different
 * people off different packs: "b 1234", "B1234 " and "B 1234" on one delivery
 * note are one batch, and treating them as three would split its balance. Null
 * for nothing typed.
 */
export function normalizeBatchNo(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
  return value === '' ? null : value
}

/**
 * The id of a product's batch, derived rather than minted.
 *
 * Two tills that receive the same batch of the same product while apart must
 * end up holding one batch, not two rows that clash on a name when they meet.
 * A derived id makes the two writes the same row, which the merge already knows
 * how to settle.
 */
export function batchIdFor(productId: string, batchNo: string): string {
  return `batch:${productId}:${batchNo}`
}

export type ParsedExpiry = { ok: true; value: string | null } | { ok: false }

/**
 * An expiry date as a person types it, read into YYYY-MM-DD.
 *
 * Packs in India mostly print a month -- "EXP 03/2027" -- and mean the end of
 * it, so a month alone is read as its last day. A full date is taken as given.
 * Accepted: `2027-03-31`, `03/2027`, `3/27`, `03-2027`, `31/03/2027`,
 * `31/03/27`. Nothing typed is no expiry, which is allowed: not everything
 * with a batch number goes off.
 */
export function parseExpiry(raw: string | null | undefined): ParsedExpiry {
  const text = (raw ?? '').trim()
  if (text === '') return { ok: true, value: null }

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))

  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text)
  if (m) return ymd(fullYear(m[3]!), Number(m[2]), Number(m[1]))

  m = /^(\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text)
  if (m) {
    const year = fullYear(m[2]!)
    const month = Number(m[1])
    if (month < 1 || month > 12) return { ok: false }
    return ymd(year, month, daysIn(year, month))
  }

  return { ok: false }
}

function fullYear(text: string): number {
  return text.length === 2 ? 2000 + Number(text) : Number(text)
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function ymd(year: number, month: number, day: number): ParsedExpiry {
  if (year < 2000 || year > 2099 || month < 1 || month > 12) return { ok: false }
  if (day < 1 || day > daysIn(year, month)) return { ok: false }
  const pad = (n: number) => String(n).padStart(2, '0')
  return { ok: true, value: `${year}-${pad(month)}-${pad(day)}` }
}

/**
 * An expiry as the shop reads it: the month when it is the last day of one,
 * which is how the pack printed it, and the whole date otherwise.
 */
export function formatExpiry(expiry: string | null): string {
  if (expiry === null) return ''
  const [y, m, d] = expiry.split('-').map(Number) as [number, number, number]
  const pad = (n: number) => String(n).padStart(2, '0')
  return d === daysIn(y, m) ? `${pad(m)}/${y}` : `${pad(d)}/${pad(m)}/${y}`
}

export type ExpiryState = 'none' | 'expired' | 'soon' | 'ok'

/**
 * Where a batch stands on a given day. The expiry date is the last day the
 * goods may be sold, so on that day they are still in date.
 */
export function expiryState(expiry: string | null, today: string, soonDays = EXPIRY_SOON_DAYS): ExpiryState {
  if (expiry === null) return 'none'
  if (expiry < today) return 'expired'
  if (expiry <= addDays(today, soonDays)) return 'soon'
  return 'ok'
}

/** One batch of a product and how much of it is on the shelf. */
export interface BatchStock {
  batchId: string
  batchNo: string
  expiryDate: string | null
  balance: Qty
}

export interface BatchTake {
  batchId: string
  qty: Qty
}

export interface Allocation {
  /** What each batch gives, in the order it was taken. */
  takes: BatchTake[]
  /** The part that comes from stock no batch accounts for, or that is not there at all. */
  unbatched: Qty
  /** True when any of it comes from a batch past its date. */
  expired: boolean
}

/**
 * Which batches a sale of `required` comes out of.
 *
 * First expiry, first out -- with the order a shopkeeper would actually hand
 * goods over in, not the order a formula would:
 *
 *   1. The batch the cashier picked, if one was, as far as it goes. The pack in
 *      the customer's hand is the one that left.
 *   2. Batches still in date, the soonest to expire first. A batch with no
 *      expiry goes after every dated one.
 *   3. Stock no batch accounts for. Goods received before the switch was on are
 *      still goods, and still sold.
 *   4. Batches past their date, soonest first -- last, because nobody hands an
 *      expired pack over while a good one is on the shelf. When the sale
 *      reaches here the result says so and the counter warns.
 *
 * What none of that covers is left as unbatched: the shelf was short, and the
 * stock policy has already had its say about that.
 */
export function allocate(
  pool: readonly BatchStock[],
  unbatchedOnHand: Qty,
  required: Qty,
  opts: {
    today: string
    pick?: string | null
    /**
     * Batches the line would rather come out of. Those not preferred wait
     * until the stock without a batch has gone, as well as the preferred
     * batches. A line priced from the item prefers batches at the item's own
     * price (070), so an old-price pack is not booked out of the new batch.
     */
    prefer?: (batch: BatchStock) => boolean
  },
): Allocation {
  const takes: BatchTake[] = []
  let left = required
  let unbatched = QTY_ZERO
  let expired = false
  const used = new Set<string>()

  const take = (batch: BatchStock): void => {
    if (left <= 0 || batch.balance <= 0 || used.has(batch.batchId)) return
    const qty = (batch.balance < left ? batch.balance : left) as Qty
    takes.push({ batchId: batch.batchId, qty })
    used.add(batch.batchId)
    left = subQty(left, qty)
    if (expiryState(batch.expiryDate, opts.today) === 'expired') expired = true
  }

  const takeUnbatched = (): void => {
    if (left > 0 && unbatchedOnHand > 0) {
      const qty = (unbatchedOnHand < left ? unbatchedOnHand : left) as Qty
      unbatched = addQty(unbatched, qty)
      left = subQty(left, qty)
      unbatchedOnHand = subQty(unbatchedOnHand, qty)
    }
  }

  if (opts.pick === UNBATCHED_PICK) takeUnbatched()
  const picked = opts.pick ? pool.find((b) => b.batchId === opts.pick) : undefined
  if (picked) take(picked)

  const ordered = [...pool].sort(fefo)
  const preferred = opts.prefer ?? (() => true)
  for (const batch of ordered) {
    if (preferred(batch) && expiryState(batch.expiryDate, opts.today) !== 'expired') take(batch)
  }

  takeUnbatched()

  for (const batch of ordered) {
    if (expiryState(batch.expiryDate, opts.today) !== 'expired') take(batch)
  }

  for (const batch of ordered) take(batch)

  if (left > 0) unbatched = addQty(unbatched, left)
  return { takes, unbatched, expired }
}

/** Soonest expiry first, undated last, then by number so the order is the same everywhere. */
export function fefo(a: BatchStock, b: BatchStock): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1
    if (b.expiryDate === null) return -1
    return a.expiryDate < b.expiryDate ? -1 : 1
  }
  return a.batchNo < b.batchNo ? -1 : a.batchNo > b.batchNo ? 1 : 0
}

/**
 * Stock the batches do not account for: what is on hand less what they hold.
 * Never below zero -- batches holding more than the shelf means a count or a
 * write-off was not put against a batch, and that is shown, not subtracted.
 */
export function unbatchedOf(onHand: Qty, pool: readonly BatchStock[]): Qty {
  const held = addQty(...pool.filter((b) => b.balance > 0).map((b) => b.balance))
  const rest = subQty(onHand, held)
  return rest > 0 ? rest : QTY_ZERO
}

/** A batch with the price its packs carry (070). Null is the item's own. */
export interface PricedBatch extends BatchStock {
  mrp: Money | null
  rate: Money | null
}

/**
 * One price the shelf holds an item at, for the cashier to choose between.
 *
 * Batches that print the same MRP and sell at the same rate are one choice,
 * not several: the customer and the cashier care which price, not which
 * delivery. The choice sells out of the batch that expires soonest among them.
 */
export interface PriceChoice {
  /** The batch to sell out of, or `UNBATCHED_PICK` for the stock without one. */
  pick: string
  /** The batch numbers this price covers. Empty for the stock without a batch. */
  batchNos: string[]
  /** The soonest expiry among them. */
  expiryDate: string | null
  mrp: Money | null
  /** Per base unit, tax inside. */
  rate: Money
  balance: Qty
}

/**
 * The prices an item is on the shelf at, cheapest MRP first.
 *
 * Only stock that is there counts: a batch sold out is not a choice. When this
 * answers fewer than two, nothing needs asking and the scan adds the line as it
 * always has -- which is every item whose batches never had a price of their
 * own, and every shop that never turned batches on.
 */
export function priceChoices(
  pool: readonly PricedBatch[],
  unbatchedOnHand: Qty,
  item: { mrp: Money | null; rate: Money },
): PriceChoice[] {
  const byPrice = new Map<string, PriceChoice>()
  const add = (pick: string, batch: PricedBatch | null, balance: Qty): void => {
    const mrp = batch?.mrp ?? item.mrp
    const rate = batch?.rate ?? item.rate
    const key = `${mrp ?? ''}:${rate}`
    const at = byPrice.get(key)
    if (!at) {
      byPrice.set(key, {
        pick, batchNos: batch ? [batch.batchNo] : [], expiryDate: batch?.expiryDate ?? null, mrp, rate, balance,
      })
      return
    }
    at.balance = addQty(at.balance, balance)
    if (batch) at.batchNos.push(batch.batchNo)
  }

  // Soonest expiry first, so the first batch at a price is the one it sells out of.
  for (const batch of [...pool].sort(fefo)) {
    if (batch.balance > 0) add(batch.batchId, batch, batch.balance)
  }
  if (unbatchedOnHand > 0) add(UNBATCHED_PICK, null, unbatchedOnHand)

  return [...byPrice.values()].sort((a, b) =>
    (a.mrp ?? a.rate) - (b.mrp ?? b.rate) || a.rate - b.rate)
}

/**
 * The batch number new stock is received under when it was given a price and
 * no number -- most shops never type one. Derived from the price, so the same
 * MRP received twice, or on two tills apart, lands in one batch.
 */
export function priceBatchNo(mrp: Money | null, rate: Money | null): string {
  const rupees = (m: Money) => (m / 100).toFixed(2)
  return mrp !== null ? `MRP ${rupees(mrp)}` : `RATE ${rupees(rate ?? (0 as Money))}`
}
