import { desc, eq, inArray, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { addDays, businessDate } from '../../dates.js'
import type { Money } from '../../money.js'
import { CANCELLED } from '../../integrity/docstatus.js'
import { FINISHED } from '../documents/read.js'
import { currentStock } from '../stock.js'
import { isListed, listedCategoryIds, shelfPrice, shelfPricer } from './catalog.js'
import { loadAccount, type WebAccount } from './accounts.js'
import { loadWebSettings } from './gate.js'

/*
 * An order from the storefront as it is read: by the customer's phone, by the
 * Orders page, and by the person deciding whether to accept it.
 *
 * Its status is read, not only stored. Once accepted, the order *is* its sales
 * order: cancelled when that is cancelled, collected when every line of it has
 * been billed (`FINISHED`). Kept beside the document it would sooner or later
 * disagree with it; read from it, it cannot.
 */

export type WebOrderStatus = 'pending' | 'accepted' | 'packing' | 'ready' | 'collected' | 'rejected' | 'cancelled'

export interface WebOrderLine {
  productId: string
  name: string
  unit: string
  /** Whole units: the storefront sells nothing loose. */
  qty: number
  /** One of the unit as the customer saw it, tax included. */
  seenPrice: Money
}

export interface WebOrderView {
  id: string
  orderNo: number
  status: WebOrderStatus
  accountId: string
  contactName: string
  contactPhone: string
  note: string | null
  lines: WebOrderLine[]
  seenTotal: Money
  tillTotal: Money | null
  documentId: string | null
  reason: string | null
  cancelRequested: boolean
  placedAt: string
  answeredAt: string | null
  readyAt: string | null
}

export const isOpen = (s: WebOrderStatus) => s === 'pending' || s === 'accepted' || s === 'packing' || s === 'ready'

export type OrderRow = typeof schema.webOrders.$inferSelect

async function viewsWhere(
  db: SqlDriver, where: ReturnType<typeof eq> | undefined, limit: number,
): Promise<WebOrderView[]> {
  const rows = await q(db).select().from(schema.webOrders).where(where)
    .orderBy(desc(schema.webOrders.orderNo)).limit(limit)
  const progress = await documentProgress(db, rows.flatMap((r) => (r.documentId ? [r.documentId] : [])))
  return rows.map((r) => toView(r, r.documentId ? progress.get(r.documentId) : undefined))
}

/** Whether each document is cancelled, and whether every line of it has been billed. */
async function documentProgress(db: SqlDriver, ids: string[]): Promise<Map<string, { cancelled: boolean; finished: boolean }>> {
  if (ids.length === 0) return new Map()
  const rows = await q(db)
    .select({
      id: schema.documents.id,
      docstatus: schema.documents.docstatus,
      lines: sql<number>`COUNT(${schema.documentItems.id})`,
      finished: FINISHED,
    })
    .from(schema.documents)
    .leftJoin(schema.documentItems, eq(schema.documentItems.documentId, schema.documents.id))
    .where(inArray(schema.documents.id, ids))
    .groupBy(schema.documents.id)
  return new Map(rows.map((r) => [r.id, {
    cancelled: r.docstatus === CANCELLED,
    finished: r.lines > 0 && r.finished === r.lines,
  }]))
}

function toView(r: OrderRow, doc: { cancelled: boolean; finished: boolean } | undefined): WebOrderView {
  let status = r.status as WebOrderStatus
  if (doc?.cancelled) status = 'cancelled'
  else if (doc?.finished) status = 'collected'
  return {
    id: r.id,
    orderNo: r.orderNo,
    status,
    accountId: r.accountId,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    note: r.note,
    lines: JSON.parse(r.linesJson) as WebOrderLine[],
    seenTotal: r.seenTotal,
    tillTotal: r.tillTotal,
    documentId: r.documentId,
    reason: r.reason,
    cancelRequested: r.cancelRequested === 1,
    placedAt: r.placedAt,
    answeredAt: r.answeredAt,
    readyAt: r.readyAt,
  }
}

export async function loadWebOrder(db: SqlDriver, id: string): Promise<WebOrderView | null> {
  return (await viewsWhere(db, eq(schema.webOrders.id, id), 1))[0] ?? null
}

/** A customer's own orders, newest first. Nobody else's, whatever id is asked for. */
export async function ordersForAccount(db: SqlDriver, accountId: string): Promise<WebOrderView[]> {
  return viewsWhere(db, eq(schema.webOrders.accountId, accountId), 50)
}

export async function orderForAccount(db: SqlDriver, accountId: string, orderId: string): Promise<WebOrderView | null> {
  const order = await loadWebOrder(db, orderId)
  return order && order.accountId === accountId ? order : null
}

export interface ShopWebOrder extends WebOrderView {
  account: WebAccount | null
  /** Accepted, not collected, and older than the shop's collection window. */
  overdue: boolean
}

export type ShopOrderFilter = 'waiting' | 'open' | 'done' | 'all'

/** The orders for the Orders page: those waiting for an answer, those not yet collected, or all. */
export async function ordersForShop(db: SqlDriver, filter: ShopOrderFilter, now: Date = new Date()): Promise<ShopWebOrder[]> {
  const views = await viewsWhere(db, undefined, 500)
  const { collectDays } = await loadWebSettings(db)
  const cutoff = addDays(businessDate(now), -collectDays)
  const keep = views.filter((v) => {
    if (filter === 'waiting') return v.status === 'pending'
    if (filter === 'open') return isOpen(v.status)
    if (filter === 'done') return !isOpen(v.status)
    return true
  })
  const out: ShopWebOrder[] = []
  for (const v of keep) {
    out.push({
      ...v,
      account: await loadAccount(db, v.accountId),
      overdue: v.answeredAt !== null && (v.status === 'accepted' || v.status === 'packing' || v.status === 'ready')
        && businessDate(new Date(v.answeredAt)) < cutoff,
    })
  }
  return out
}

export interface ReviewLine extends WebOrderLine {
  /** One of the unit at the till's price today, tax included. */
  tillPrice: Money
  /** On hand in the item's base unit, as the counter would show it. */
  onHand: number
  /** Still sold and still in a listed category. */
  listed: boolean
}

/** A pending order beside what the till would charge for it now and what is on the shelf. */
export async function reviewWebOrder(
  db: SqlDriver, id: string, now: Date = new Date(),
): Promise<{ order: WebOrderView; lines: ReviewLine[] } | null> {
  const order = await loadWebOrder(db, id)
  if (!order) return null
  const pricer = await shelfPricer(db)
  const categories = await listedCategoryIds(db)
  const lines: ReviewLine[] = []
  for (const line of order.lines) {
    const base = await q(db).select({ baseUnit: schema.products.baseUnit }).from(schema.products)
      .where(eq(schema.products.id, line.productId))
    const s = await shelfPrice(db, pricer, line.productId, line.unit === base[0]?.baseUnit ? null : line.unit, now)
    lines.push({
      ...line,
      tillPrice: s.price,
      onHand: await currentStock(db, line.productId),
      listed: await isListed(db, line.productId, categories),
    })
  }
  return { order, lines }
}
