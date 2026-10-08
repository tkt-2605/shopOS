import { eq, and, inArray, sql, asc, gt } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { type Qty, qty, negQty, subQty, formatQty } from '../quantity.js'
import { addDays } from '../dates.js'
import {
  allocate, batchIdFor, fefo, formatExpiry, normalizeBatchNo, priceBatchNo, priceChoices, unbatchedOf, BATCH_NO_MAX,
  EXPIRY_SOON_DAYS, type Allocation, type BatchStock, type PriceChoice,
} from '../domain/batches.js'
import type { Money } from '../money.js'
import { currentStock } from './stock.js'

/**
 * Batches: which batch each unit of stock belongs to, beside the stock ledger.
 *
 * The ledger stays the truth about quantity and value and knows nothing of
 * this module. Documents that move stock call in here in the same transaction
 * and at four points only -- goods received on a stock entry, goods sold on a
 * bill, goods back on a return, and any of those cancelled -- so pulling this
 * module out leaves every one of them working exactly as before it existed.
 *
 * A batch's balance is the sum of its movements, read when asked. There is no
 * cache and therefore nothing to drift; `idx_batch_movements_batch` makes the
 * sum an index range per batch.
 *
 * The feature switch (`batchExpiry` in features.ts) decides what a person is
 * asked, not what the books do. A shop that switches it off keeps its batches,
 * and a sale of a batched item still comes out of them -- otherwise turning it
 * back on would find every balance wrong by whatever was sold in between.
 */

export interface BatchRow {
  batchId: string
  productId: string
  batchNo: string
  expiryDate: string | null
  balance: Qty
  /** The MRP and selling rate this batch carries of its own (070). Null is the item's. */
  mrp: Money | null
  rate: Money | null
}

const BALANCE = sql<number>`coalesce(sum(${schema.batchMovements.qtyChange}), 0)`

/** Every batch of a product with what it holds, soonest expiry first. */
export async function batchesOf(
  db: SqlDriver,
  productId: string,
  opts: { inStockOnly?: boolean } = {},
): Promise<BatchRow[]> {
  const rows = await q(db)
    .select({
      batchId: schema.batches.id,
      productId: schema.batches.productId,
      batchNo: schema.batches.batchNo,
      expiryDate: schema.batches.expiryDate,
      mrp: schema.batches.mrp,
      rate: schema.batches.rate,
      balance: BALANCE,
    })
    .from(schema.batches)
    .leftJoin(schema.batchMovements, eq(schema.batchMovements.batchId, schema.batches.id))
    .where(eq(schema.batches.productId, productId))
    .groupBy(schema.batches.id)

  return rows
    .map((r) => ({ ...r, balance: qty(Number(r.balance)) }))
    .filter((r) => !opts.inStockOnly || r.balance > 0)
    .sort(fefo)
}

/** The products among these that have ever had a batch. One indexed query. */
export async function productsWithBatches(db: SqlDriver, productIds: readonly string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set()
  const rows = await q(db)
    .selectDistinct({ productId: schema.batches.productId })
    .from(schema.batches)
    .where(inArray(schema.batches.productId, [...new Set(productIds)]))
  return new Set(rows.map((r) => r.productId))
}

export interface SalePlan extends Allocation {
  /** The batches the plan was made from, so a screen can name them. */
  pool: BatchRow[]
}

/**
 * Which batches a sale of this much would come out of, without writing
 * anything. The counter shows this beside the line; `issueForSale` makes the
 * same decision when the bill is submitted.
 */
export async function planSale(
  db: SqlDriver,
  productId: string,
  required: Qty,
  opts: { today: string; pick?: string | null },
): Promise<SalePlan> {
  const pool = await batchesOf(db, productId)
  const unbatched = unbatchedOf(await currentStock(db, productId), pool)
  // The same preference `issueForSale` applies, so the line shows what the bill will do.
  const priced = pool.some((b) => b.mrp !== null || b.rate !== null)
  const prefer = priced && !opts.pick ? { prefer: (b: BatchStock) => !hasOwnPrice(pool, b.batchId) } : {}
  return { ...allocate(pool, unbatched, required, { ...opts, ...prefer }), pool }
}

/**
 * The prices this item is on the shelf at, when there is more than one to
 * choose between -- and an empty list when there is not, which is what the
 * counter checks before it asks anybody anything. See `priceChoices`.
 */
export async function priceChoicesFor(db: SqlDriver, productId: string): Promise<PriceChoice[]> {
  const pool = await batchesOf(db, productId)
  if (!pool.some((b) => b.balance > 0 && (b.mrp !== null || b.rate !== null))) return []
  const [item] = await q(db)
    .select({ mrp: schema.products.mrp, rate: schema.products.baseRate })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (!item) return []
  const choices = priceChoices(pool, unbatchedOf(await currentStock(db, productId), pool), item)
  return choices.length > 1 ? choices : []
}

export type EnsureBatchResult =
  | { ok: true; batchId: string; batchNo: string }
  | { ok: false; code: 'BAD_BATCH_NO' }
  | { ok: false; code: 'BAD_EXPIRY' }
  | { ok: false; code: 'EXPIRY_MISMATCH'; batchNo: string; recorded: string }

/**
 * A batch number checked against what is already recorded, without writing.
 *
 * A batch has one expiry: it is printed on every pack of it. A delivery that
 * gives the same number a different date is a typing mistake on one side, and
 * which side is not something the till can know, so it is refused with the
 * date already on record. A batch recorded with no date takes the first one
 * it is given.
 */
export async function checkBatch(
  db: SqlDriver,
  productId: string,
  rawBatchNo: string,
  expiryDate: string | null,
): Promise<EnsureBatchResult> {
  const batchNo = normalizeBatchNo(rawBatchNo)
  if (batchNo === null || batchNo.length > BATCH_NO_MAX) return { ok: false, code: 'BAD_BATCH_NO' }
  if (expiryDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return { ok: false, code: 'BAD_EXPIRY' }

  const batchId = batchIdFor(productId, batchNo)
  const [existing] = await q(db)
    .select({ expiryDate: schema.batches.expiryDate })
    .from(schema.batches)
    .where(eq(schema.batches.id, batchId))
  if (existing?.expiryDate && expiryDate !== null && existing.expiryDate !== expiryDate) {
    return { ok: false, code: 'EXPIRY_MISMATCH', batchNo, recorded: existing.expiryDate }
  }
  return { ok: true, batchId, batchNo }
}

/**
 * Writes the batch if it is new, or gives it the expiry it was missing. Call `checkBatch` first.
 *
 * A price given (070) is the batch's from then on: the delivery that names one
 * is the latest word on what those packs say and sell at. A price not given
 * leaves whatever the batch already carries.
 */
export async function ensureBatch(
  tx: SqlDriver,
  input: {
    productId: string; batchNo: string; expiryDate: string | null; now: Date
    mrp?: Money | null; rate?: Money | null
  },
): Promise<string> {
  const batchId = batchIdFor(input.productId, input.batchNo)
  const nowIso = input.now.toISOString()
  const [existing] = await q(tx)
    .select({ expiryDate: schema.batches.expiryDate, mrp: schema.batches.mrp, rate: schema.batches.rate })
    .from(schema.batches)
    .where(eq(schema.batches.id, batchId))

  if (!existing) {
    await q(tx).insert(schema.batches).values({
      id: batchId,
      productId: input.productId,
      batchNo: input.batchNo,
      expiryDate: input.expiryDate,
      mrp: input.mrp ?? null,
      rate: input.rate ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    return batchId
  }

  const change: { expiryDate?: string; mrp?: Money; rate?: Money } = {}
  if (existing.expiryDate === null && input.expiryDate !== null) change.expiryDate = input.expiryDate
  if (input.mrp != null && input.mrp !== existing.mrp) change.mrp = input.mrp
  if (input.rate != null && input.rate !== existing.rate) change.rate = input.rate
  if (Object.keys(change).length > 0) {
    await q(tx).update(schema.batches)
      .set({ ...change, updatedAt: nowIso })
      .where(eq(schema.batches.id, batchId))
  }
  return batchId
}

/** A product's batch by the number a person typed or picked. */
export async function findBatch(db: SqlDriver, productId: string, rawBatchNo: string): Promise<BatchRow | null> {
  const batchNo = normalizeBatchNo(rawBatchNo)
  if (batchNo === null) return null
  const id = batchIdFor(productId, batchNo)
  return (await batchesOf(db, productId)).find((b) => b.batchId === id) ?? null
}

interface Movement {
  batchId: string
  productId: string
  qtyChange: Qty
  voucherType: string
  voucherId: string
  voucherLineId: string | null
  postingDate: string
  userId: string | null
}

async function post(tx: SqlDriver, m: Movement): Promise<void> {
  if (m.qtyChange === 0) return
  await q(tx).insert(schema.batchMovements).values({
    id: newId(),
    batchId: m.batchId,
    productId: m.productId,
    qtyChange: m.qtyChange,
    voucherType: m.voucherType,
    voucherId: m.voucherId,
    voucherLineId: m.voucherLineId,
    postingDate: m.postingDate,
    createdBy: m.userId,
    createdAt: new Date().toISOString(),
  })
}

/** Stock moved in or out of a named batch on a stock entry line. */
export async function moveBatch(tx: SqlDriver, m: Movement): Promise<void> {
  await post(tx, m)
}

export interface SaleLine {
  lineId: string
  productId: string
  /** Base units. */
  qty: Qty
  pick?: string | null
}

/**
 * Takes a bill's lines out of their batches. Must run before the bill's own
 * stock movements, because stock no batch accounts for is read off the shelf
 * as it stood.
 *
 * Only products that have ever had a batch are looked at, so a shop that has
 * never used batches pays one indexed query per bill and nothing more.
 */
export async function issueForSale(
  tx: SqlDriver,
  input: {
    voucherType: string
    voucherId: string
    postingDate: string
    userId: string | null
    lines: readonly SaleLine[]
  },
): Promise<void> {
  const batched = await productsWithBatches(tx, input.lines.map((l) => l.productId))
  if (batched.size === 0) return

  // Held in memory across lines, so two lines of one product do not both take the same pack.
  const pools = new Map<string, { pool: BatchRow[]; unbatched: Qty }>()

  for (const line of input.lines) {
    if (!batched.has(line.productId)) continue
    let held = pools.get(line.productId)
    if (!held) {
      const pool = await batchesOf(tx, line.productId)
      held = { pool, unbatched: unbatchedOf(await currentStock(tx, line.productId), pool) }
      pools.set(line.productId, held)
    }

    /* A line with no batch of its own was priced from the item, so it sells
       stock at the item's price first -- not a newer batch at another MRP. */
    const priced = held.pool.some((b) => b.mrp !== null || b.rate !== null)
    const plan = allocate(held.pool, held.unbatched, line.qty, {
      today: input.postingDate,
      pick: line.pick ?? null,
      ...(priced && !line.pick ? { prefer: (b: BatchStock) => !hasOwnPrice(held!.pool, b.batchId) } : {}),
    })
    for (const take of plan.takes) {
      await post(tx, {
        batchId: take.batchId,
        productId: line.productId,
        qtyChange: negQty(take.qty),
        voucherType: input.voucherType,
        voucherId: input.voucherId,
        voucherLineId: line.lineId,
        postingDate: input.postingDate,
        userId: input.userId,
      })
      const batch = held.pool.find((b) => b.batchId === take.batchId)!
      batch.balance = subQty(batch.balance, take.qty)
    }
    held.unbatched = qty(Math.max(0, held.unbatched - plan.unbatched))
  }
}

/**
 * Puts returned goods back into the batches the bill line took them from.
 *
 * What a line still has out is what the bill took less what earlier returns
 * of the same line put back, per batch -- read from the movements themselves,
 * so a return on another till is counted once it has synced. Anything beyond
 * what the batches gave came from unbatched stock and goes back there.
 */
export async function putBackReturn(
  tx: SqlDriver,
  input: {
    returnId: string
    postingDate: string
    userId: string | null
    lines: readonly { billItemId: string; productId: string; qty: Qty }[]
  },
): Promise<void> {
  const lineIds = input.lines.map((l) => l.billItemId)
  if (lineIds.length === 0) return

  const out = await q(tx)
    .select({
      lineId: schema.batchMovements.voucherLineId,
      batchId: schema.batchMovements.batchId,
      batchNo: schema.batches.batchNo,
      expiryDate: schema.batches.expiryDate,
      net: sql<number>`sum(${schema.batchMovements.qtyChange})`,
    })
    .from(schema.batchMovements)
    .innerJoin(schema.batches, eq(schema.batches.id, schema.batchMovements.batchId))
    .where(and(
      inArray(schema.batchMovements.voucherLineId, lineIds),
      inArray(schema.batchMovements.voucherType, ['bill', 'sales_return', 'sales_return_reversal']),
    ))
    .groupBy(schema.batchMovements.voucherLineId, schema.batchMovements.batchId)
  if (out.length === 0) return

  for (const line of input.lines) {
    const taken = out
      .filter((r) => r.lineId === line.billItemId && Number(r.net) < 0)
      .map((r) => ({ batchId: r.batchId, batchNo: r.batchNo, expiryDate: r.expiryDate, balance: qty(-Number(r.net)) }))
      .sort(fefo)
    let left = line.qty
    for (const batch of taken) {
      if (left <= 0) break
      const back = (batch.balance < left ? batch.balance : left) as Qty
      await post(tx, {
        batchId: batch.batchId,
        productId: line.productId,
        qtyChange: back,
        voucherType: 'sales_return',
        voucherId: input.returnId,
        voucherLineId: line.billItemId,
        postingDate: input.postingDate,
        userId: input.userId,
      })
      left = subQty(left, back)
    }
  }
}

/** Undoes every batch movement a document made, as `reverseVoucher` does for the ledger. */
export async function reverseBatches(
  tx: SqlDriver,
  voucherType: string,
  voucherId: string,
  postingDate: string,
  userId: string | null,
): Promise<void> {
  const moves = await q(tx)
    .select({
      batchId: schema.batchMovements.batchId,
      productId: schema.batchMovements.productId,
      qtyChange: schema.batchMovements.qtyChange,
      voucherLineId: schema.batchMovements.voucherLineId,
    })
    .from(schema.batchMovements)
    .where(and(
      eq(schema.batchMovements.voucherType, voucherType),
      eq(schema.batchMovements.voucherId, voucherId),
    ))
    .orderBy(asc(schema.batchMovements.id))

  for (const m of moves) {
    await post(tx, {
      ...m,
      qtyChange: negQty(m.qtyChange),
      voucherType: `${voucherType}_reversal`,
      voucherId,
      postingDate,
      userId,
    })
  }
}

export interface LineBatch {
  batchNo: string
  expiryDate: string | null
  qty: Qty
}

/**
 * What batches each line of a document went out of or came in to, for the
 * printed bill and the screens that show one. Keyed by line id.
 */
export async function batchesOnVoucher(
  db: SqlDriver,
  voucherType: string,
  voucherId: string,
): Promise<Map<string, LineBatch[]>> {
  const rows = await q(db)
    .select({
      lineId: schema.batchMovements.voucherLineId,
      batchNo: schema.batches.batchNo,
      expiryDate: schema.batches.expiryDate,
      qtyChange: schema.batchMovements.qtyChange,
    })
    .from(schema.batchMovements)
    .innerJoin(schema.batches, eq(schema.batches.id, schema.batchMovements.batchId))
    .where(and(
      eq(schema.batchMovements.voucherType, voucherType),
      eq(schema.batchMovements.voucherId, voucherId),
    ))
    .orderBy(asc(schema.batchMovements.id))

  const byLine = new Map<string, LineBatch[]>()
  for (const r of rows) {
    if (r.lineId === null) continue
    const list = byLine.get(r.lineId) ?? []
    list.push({ batchNo: r.batchNo, expiryDate: r.expiryDate, qty: qty(Math.abs(r.qtyChange)) })
    byLine.set(r.lineId, list)
  }
  return byLine
}

/**
 * Each line's batches as the printed bill says them -- "Batch B101 Exp
 * 03/2027", with a count per batch when a line came out of more than one.
 * Keyed by bill line id; a line with no batch is absent.
 *
 * Printed whenever the bill recorded batches, whatever the switch says now:
 * the paper describes what happened.
 */
export async function batchTextFor(db: SqlDriver, billId: string): Promise<Map<string, string>> {
  const byLine = await batchesOnVoucher(db, 'bill', billId)
  const out = new Map<string, string>()
  for (const [lineId, list] of byLine) {
    const parts = list.map((b) => {
      const count = list.length > 1 ? ` x${formatQty(b.qty)}` : ''
      return `${b.batchNo}${count}${b.expiryDate ? ` Exp ${formatExpiry(b.expiryDate)}` : ''}`
    })
    out.set(lineId, `Batch ${parts.join(', ')}`)
  }
  return out
}

export interface ExpiringBatch extends BatchRow {
  productName: string
  baseUnit: string
}

/**
 * Batches with stock that expire on or before `today + withinDays`, the
 * already expired included, soonest first. What the shop should pull off the
 * shelf or send back to the distributor.
 */
export async function expiringBatches(
  db: SqlDriver,
  opts: { today: string; withinDays?: number },
): Promise<ExpiringBatch[]> {
  const until = addDays(opts.today, opts.withinDays ?? EXPIRY_SOON_DAYS)
  const rows = await q(db)
    .select({
      batchId: schema.batches.id,
      productId: schema.batches.productId,
      batchNo: schema.batches.batchNo,
      expiryDate: schema.batches.expiryDate,
      productName: schema.products.name,
      baseUnit: schema.products.baseUnit,
      mrp: schema.batches.mrp,
      rate: schema.batches.rate,
      balance: BALANCE,
    })
    .from(schema.batches)
    .innerJoin(schema.products, eq(schema.products.id, schema.batches.productId))
    .innerJoin(schema.batchMovements, eq(schema.batchMovements.batchId, schema.batches.id))
    .where(sql`${schema.batches.expiryDate} IS NOT NULL AND ${schema.batches.expiryDate} <= ${until}`)
    .groupBy(schema.batches.id)
    .having(gt(BALANCE, 0))
    .orderBy(asc(schema.batches.expiryDate), asc(schema.products.name))

  return rows.map((r) => ({ ...r, balance: qty(Number(r.balance)) }))
}

/**
 * The price a line of incoming goods gives its batch (070), when it gives one
 * that is not the item's own -- or null, when the packs are the item's
 * ordinary stock. A price left blank follows the item, except a rate that
 * would sell the packs above the MRP printed on them, which is held at it.
 *
 * `batchNo` is what the goods are received under when nobody typed a number,
 * which is most shops: named by the price, so the same MRP received twice, or
 * on two tills apart, lands in one batch.
 */
export async function incomingPrice(
  db: SqlDriver,
  productId: string,
  mrp: Money | null,
  saleRate: Money | null,
): Promise<{ mrp: Money | null; rate: Money | null; batchNo: string } | null> {
  if (mrp === null && saleRate === null) return null
  const [item] = await q(db)
    .select({ mrp: schema.products.mrp, rate: schema.products.baseRate })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (!item) return null
  const rate = saleRate ?? (mrp !== null && item.rate > mrp ? mrp : null)
  const differs = (mrp !== null && mrp !== item.mrp) || (rate !== null && rate !== item.rate)
  return differs ? { mrp, rate, batchNo: priceBatchNo(mrp, rate) } : null
}

function hasOwnPrice(pool: readonly BatchRow[], batchId: string): boolean {
  const batch = pool.find((b) => b.batchId === batchId)
  return batch !== undefined && (batch.mrp !== null || batch.rate !== null)
}
