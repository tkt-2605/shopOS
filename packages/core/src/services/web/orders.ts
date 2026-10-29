import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import type { Money } from '../../money.js'
import { fromUnits } from '../../quantity.js'
import { CANCELLED } from '../../integrity/docstatus.js'
import { requirePermission } from '../../integrity/permissions.js'
import { writeAudit } from '../../integrity/audit.js'
import { createDocument } from '../documents/create.js'
import { submitDocument, cancelDocument } from '../documents/lifecycle.js'
import { createCustomer, customerByPhone } from '../customers.js'
import { isListed, listedCategoryIds } from './catalog.js'
import { loadAccount, type WebAccount } from './accounts.js'
import { answersOnlineOrders, loadWebSettings } from './gate.js'
import {
  isOpen, loadWebOrder, orderForAccount, ordersForAccount,
  type OrderRow, type WebOrderLine, type WebOrderStatus, type WebOrderView,
} from './orderViews.js'

/*
 * An order from the storefront, from the moment it arrives until it is
 * collected or turned away.
 *
 * It arrives `pending` and stays that way until a person at the main answers
 * it. Nothing about it is a document yet: it is a request, with the prices the
 * customer was shown. Accepting it raises an ordinary sales order, priced by
 * the till as any other would be, and from then on the order *is* that
 * document -- billed at any counter through "Bill it", and collected when
 * every line has been billed (`FINISHED`). Its status on the phone is read
 * from the document, never kept beside it, so the two cannot disagree.
 *
 * Accepting is done by the person at the main, under their own name and
 * permissions -- the same `document` `create` that raises any sales order.
 * There is no system user that accepts orders by itself.
 */


/** What the phone sends for one line. */
export interface WebOrderLineInput {
  productId: string
  /** The sale unit's name as the catalogue gave it. */
  unit: string
  qty: number
  price: number
}

export const MAX_LINES = 40
export const MAX_QTY = 999
export const MAX_OPEN_ORDERS = 3

/** How an order is named to a person: "Order #12", on the phone, the till and the sales order alike. */
export const orderLabel = (orderNo: number) => `Order #${orderNo}`
const NOTE = (orderNo: number) => `Online ${orderLabel(orderNo).toLowerCase()}`
/* What 0.5.0 wrote, so an order accepted then is still found by its note. */
const OLD_NOTE = (orderNo: number) => `Online order W-${orderNo}`

export type PlaceOrderResult =
  | { ok: true; order: WebOrderView }
  | { ok: false; code: 'NO_CONTACT' | 'NO_LINES' | 'TOO_MANY_LINES' | 'BAD_LINE' | 'BAD_ORDER_ID' | 'TOO_MANY_OPEN' | 'UNKNOWN_ACCOUNT' }
  | { ok: false; code: 'NOT_LISTED'; productId: string }

export async function placeOrder(
  db: SqlDriver,
  input: { accountId: string; clientOrderId: string; lines: WebOrderLineInput[]; catalogHash?: string | null; note?: string | null },
  now: Date,
): Promise<PlaceOrderResult> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.clientOrderId)) return { ok: false, code: 'BAD_ORDER_ID' }
  const account = await loadAccount(db, input.accountId)
  if (!account) return { ok: false, code: 'UNKNOWN_ACCOUNT' }

  /* Sent twice over a bad line: the first one is the order. */
  const [already] = await q(db).select({ id: schema.webOrders.id }).from(schema.webOrders)
    .where(and(eq(schema.webOrders.accountId, account.id), eq(schema.webOrders.clientOrderId, input.clientOrderId)))
  if (already) return { ok: true, order: (await loadWebOrder(db, already.id))! }

  if (!account.name || !account.phone) return { ok: false, code: 'NO_CONTACT' }
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }
  if (input.lines.length > MAX_LINES) return { ok: false, code: 'TOO_MANY_LINES' }

  const categories = await listedCategoryIds(db)
  /* Asked for a quotation: whatever price the phone sends, none was shown. */
  const quoting = (await loadWebSettings(db)).quotes
  const lines: WebOrderLine[] = []
  for (const line of input.lines) {
    if (typeof line.productId !== 'string' || typeof line.unit !== 'string'
      || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY
      || !Number.isInteger(line.price) || line.price < 0) {
      return { ok: false, code: 'BAD_LINE' }
    }
    if (!await isListed(db, line.productId, categories)) return { ok: false, code: 'NOT_LISTED', productId: line.productId }
    const [product] = await q(db)
      .select({ name: schema.products.name, brand: schema.products.brand, baseUnit: schema.products.baseUnit })
      .from(schema.products).where(eq(schema.products.id, line.productId))
    if (line.unit !== product!.baseUnit && !await hasUnit(db, line.productId, line.unit)) {
      return { ok: false, code: 'BAD_LINE' }
    }
    lines.push({ productId: line.productId, name: withBrand(product!.name, product!.brand), unit: line.unit, qty: line.qty, seenPrice: (quoting ? 0 : line.price) as Money })
  }

  if (await openOrderCount(db, account.id) >= MAX_OPEN_ORDERS) return { ok: false, code: 'TOO_MANY_OPEN' }

  const id = newId()
  const at = now.toISOString()
  await db.transaction(async (tx) => {
    const [top] = await q(tx).select({ n: sql<number | null>`MAX(${schema.webOrders.orderNo})` }).from(schema.webOrders)
    await q(tx).insert(schema.webOrders).values({
      id,
      orderNo: (top?.n ?? 0) + 1,
      accountId: account.id,
      clientOrderId: input.clientOrderId,
      status: 'pending',
      contactName: account.name!,
      contactPhone: account.phone!,
      note: input.note?.trim().slice(0, 300) || null,
      linesJson: JSON.stringify(lines),
      catalogHash: input.catalogHash ?? null,
      seenTotal: lines.reduce((sum, l) => sum + l.seenPrice * l.qty, 0) as Money,
      placedAt: at,
      createdAt: at,
      updatedAt: at,
    })
  })
  return { ok: true, order: (await loadWebOrder(db, id))! }
}

/** "Ball pen (Cello)", as the storefront shows it, unless the name already says the brand. */
export function withBrand(name: string, brand: string | null): string {
  const b = brand?.trim()
  return !b || name.toLowerCase().includes(b.toLowerCase()) ? name : `${name} (${b})`
}

export async function hasUnit(db: SqlDriver, productId: string, unit: string): Promise<boolean> {
  const [row] = await q(db).select({ id: schema.productUnits.id }).from(schema.productUnits)
    .where(and(
      eq(schema.productUnits.productId, productId),
      eq(schema.productUnits.saleUnit, unit),
      isNull(schema.productUnits.deletedAt),
    ))
  return row !== undefined
}

async function openOrderCount(db: SqlDriver, accountId: string): Promise<number> {
  return (await ordersForAccount(db, accountId)).filter((v) => isOpen(v.status)).length
}

// ---------------------------------------------------------------- answering

export type AcceptResult =
  | { ok: true; documentId: string; docNo: string; tillTotal: Money }
  | { ok: false; code: 'NOT_THE_MAIN' | 'NOT_FOUND' | 'NOT_PENDING' | 'AWAITING_CUSTOMER' | 'NO_CUSTOMER' | 'NO_LINES' | 'INVALID_QTY' | 'UNKNOWN_PRODUCT' | 'PARTY_REQUIRED'; productId?: string }

/**
 * Accepted by the person at the main: a submitted sales order for the
 * customer, priced by the till, which any counter can then bill.
 */
export async function acceptWebOrder(
  db: SqlDriver,
  input: { webOrderId: string; actorId: string; registerId: string; now?: Date },
): Promise<AcceptResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  if (!await answersOnlineOrders(db)) return { ok: false, code: 'NOT_THE_MAIN' }
  const now = input.now ?? new Date()
  const order = await loadWebOrder(db, input.webOrderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  if (order.status !== 'pending') return { ok: false, code: 'NOT_PENDING' }
  /* Changes sent back and not yet answered: accepting now would take the list
     the customer asked for, which the shop has just said it cannot fill. */
  if (order.proposal !== null) return { ok: false, code: 'AWAITING_CUSTOMER' }

  const account = await loadAccount(db, order.accountId)
  const customerId = await customerFor(db, account, order, input.actorId)
  if (customerId === null) return { ok: false, code: 'NO_CUSTOMER' }

  /* A sales order already raised for this order -- the till stopped between
     raising it and saying so below -- is the one to use, not a second one. */
  let documentId: string
  let docNo: string
  const [earlier] = await q(db)
    .select({ id: schema.documents.id, docNo: schema.documents.docNo, docstatus: schema.documents.docstatus })
    .from(schema.documents)
    .where(and(
      eq(schema.documents.kind, 'sales_order'),
      eq(schema.documents.customerId, customerId),
      inArray(schema.documents.notes, [NOTE(order.orderNo), OLD_NOTE(order.orderNo)]),
    ))
  if (earlier && earlier.docstatus !== CANCELLED) {
    documentId = earlier.id
    docNo = earlier.docNo
  } else {
    const made = await createDocument(db, {
      kind: 'sales_order',
      registerId: input.registerId,
      customerId,
      lines: order.lines.map((l) => ({ productId: l.productId, saleUnit: l.unit, qty: fromUnits(l.qty) })),
      notes: NOTE(order.orderNo),
      actorId: input.actorId,
      now,
    })
    if (!made.ok) return { ok: false, code: made.code, ...(made.productId ? { productId: made.productId } : {}) }
    documentId = made.documentId
    docNo = made.docNo
  }
  await submitDocument(db, { documentId, actorId: input.actorId, now })

  const [doc] = await q(db).select({ grandTotal: schema.documents.grandTotal }).from(schema.documents)
    .where(eq(schema.documents.id, documentId))
  const at = now.toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.webOrders).set({
      status: 'accepted', documentId, tillTotal: doc!.grandTotal, answeredAt: at, answeredBy: input.actorId, updatedAt: at,
    }).where(eq(schema.webOrders.id, order.id))
    if (account && account.customerId !== customerId) {
      await q(tx).update(schema.webAccounts).set({ customerId, updatedAt: at }).where(eq(schema.webAccounts.id, account.id))
    }
    await writeAudit(tx, { actorId: input.actorId, now: () => at }, {
      entity: 'web_orders', entityId: order.id, action: 'submit', after: { status: 'accepted', document_id: documentId },
    })
  })
  return { ok: true, documentId, docNo, tillTotal: doc!.grandTotal }
}

/**
 * The shop's customer an order is billed to.
 *
 * The one the account is already linked to; else, when a cashier has checked
 * the phone face to face, the shop's customer with that phone; else a new
 * customer. Never a match on a phone nobody has checked: that would hand a
 * stranger who typed somebody's number their price list and their khata.
 */
async function customerFor(
  db: SqlDriver, account: WebAccount | null, order: WebOrderView, actorId: string,
): Promise<string | null> {
  if (account?.customerId) {
    const [held] = await q(db).select({ id: schema.customers.id }).from(schema.customers)
      .where(and(eq(schema.customers.id, account.customerId), isNull(schema.customers.deletedAt)))
    if (held) return held.id
  }
  if (account?.phoneVerified && account.phone) {
    const match = await customerByPhone(db, account.phone)
    if (match) return match.id
  }
  const name = (account?.name || order.contactName).trim()
  const made = await createCustomer(db, { actorId }, { name, phone: order.contactPhone })
  if (made.ok) return made.customerId
  /* The shop allows one customer per phone and somebody already has this one,
     unchecked. A customer without the phone rather than the wrong customer. */
  if (made.code === 'PHONE_TAKEN') {
    const bare = await createCustomer(db, { actorId }, { name })
    return bare.ok ? bare.customerId : null
  }
  return null
}

export type AnswerResult = { ok: true } | { ok: false; code: 'NOT_THE_MAIN' | 'NOT_FOUND' | 'NOT_PENDING' | 'NOT_ACCEPTED' | 'REASON_REQUIRED' | 'ALREADY_BILLED' }

/** Turned away before anything was raised for it. */
export async function rejectWebOrder(
  db: SqlDriver, input: { webOrderId: string; actorId: string; reason: string; now?: Date },
): Promise<AnswerResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  if (!await answersOnlineOrders(db)) return { ok: false, code: 'NOT_THE_MAIN' }
  const reason = input.reason.trim().slice(0, 200)
  if (reason === '') return { ok: false, code: 'REASON_REQUIRED' }
  const order = await loadWebOrder(db, input.webOrderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  if (order.status !== 'pending') return { ok: false, code: 'NOT_PENDING' }
  await setStatus(db, order.id, 'rejected', input.actorId, input.now ?? new Date(), { reason })
  return { ok: true }
}

/** Being packed, then ready to collect. Read by the customer's phone. */
export async function markWebOrder(
  db: SqlDriver, input: { webOrderId: string; actorId: string; to: 'packing' | 'ready'; now?: Date },
): Promise<AnswerResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  if (!await answersOnlineOrders(db)) return { ok: false, code: 'NOT_THE_MAIN' }
  const order = await loadWebOrder(db, input.webOrderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  const from: WebOrderStatus[] = input.to === 'packing' ? ['accepted'] : ['accepted', 'packing']
  if (!from.includes(order.status)) return { ok: false, code: 'NOT_ACCEPTED' }
  const now = input.now ?? new Date()
  await setStatus(db, order.id, input.to, input.actorId, now,
    input.to === 'packing' ? { packingAt: now.toISOString() } : { readyAt: now.toISOString() })
  return { ok: true }
}

/**
 * An accepted order called off by the shop -- the customer asked, or never
 * came. Its sales order is cancelled the way any is, which refuses once
 * anything has been billed against it.
 */
export async function cancelWebOrder(
  db: SqlDriver, input: { webOrderId: string; actorId: string; reason: string; now?: Date },
): Promise<AnswerResult> {
  const reason = input.reason.trim().slice(0, 200)
  if (reason === '') return { ok: false, code: 'REASON_REQUIRED' }
  if (!await answersOnlineOrders(db)) return { ok: false, code: 'NOT_THE_MAIN' }
  const order = await loadWebOrder(db, input.webOrderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  if (order.documentId === null || !isOpen(order.status) || order.status === 'pending') {
    return { ok: false, code: 'NOT_ACCEPTED' }
  }
  const cancelled = await cancelDocument(db, {
    documentId: order.documentId, reason, actorId: input.actorId, ...(input.now ? { now: input.now } : {}),
  })
  if (!cancelled.ok && cancelled.code !== 'ALREADY_CANCELLED') return { ok: false, code: 'ALREADY_BILLED' }
  await setStatus(db, order.id, 'cancelled', input.actorId, input.now ?? new Date(), { reason })
  return { ok: true }
}

/**
 * The customer calls it off. Before the shop has answered, that is the end of
 * it. After, it is a request the shop sees and acts on with `cancelWebOrder`:
 * the goods may already be in a bag.
 */
export async function customerCancel(
  db: SqlDriver, input: { accountId: string; orderId: string; now: Date },
): Promise<{ ok: true; order: WebOrderView } | { ok: false; code: 'NOT_FOUND' | 'TOO_LATE' }> {
  const order = await orderForAccount(db, input.accountId, input.orderId)
  if (!order) return { ok: false, code: 'NOT_FOUND' }
  const at = input.now.toISOString()
  if (order.status === 'pending') {
    await setStatus(db, order.id, 'cancelled', null, input.now, { reason: 'Cancelled by the customer' })
  } else if (isOpen(order.status)) {
    await q(db).update(schema.webOrders).set({ cancelRequested: 1, updatedAt: at }).where(eq(schema.webOrders.id, order.id))
  } else {
    return { ok: false, code: 'TOO_LATE' }
  }
  return { ok: true, order: (await loadWebOrder(db, order.id))! }
}

/**
 * Orders nobody answered in time, turned away so the customer is not left
 * waiting -- only when the shop has set a limit. With none (0, the default) an
 * unanswered order stays waiting until a person answers it.
 */
export async function expireUnanswered(db: SqlDriver, now: Date = new Date()): Promise<number> {
  const { answerMinutes } = await loadWebSettings(db)
  if (answerMinutes === 0) return 0
  const before = new Date(now.getTime() - answerMinutes * 60_000).toISOString()
  const stale = await q(db).select({ id: schema.webOrders.id }).from(schema.webOrders)
    /* Not one sent back to the customer: it is waiting on them, not on the shop. */
    .where(and(eq(schema.webOrders.status, 'pending'), lt(schema.webOrders.placedAt, before), isNull(schema.webOrders.proposedAt)))
  for (const { id } of stale) {
    await setStatus(db, id, 'rejected', null, now, { reason: 'The shop could not answer in time' })
  }
  return stale.length
}

async function setStatus(
  db: SqlDriver, id: string, status: Exclude<WebOrderStatus, 'collected'>, actorId: string | null, now: Date,
  extra: Partial<Pick<OrderRow, 'reason' | 'packingAt' | 'readyAt'>> = {},
): Promise<void> {
  const at = now.toISOString()
  const answered = status === 'rejected' || (status === 'cancelled' && actorId !== null)
  await db.transaction(async (tx) => {
    await q(tx).update(schema.webOrders).set({
      status,
      ...extra,
      ...(answered ? { answeredAt: at, answeredBy: actorId } : {}),
      updatedAt: at,
    }).where(eq(schema.webOrders.id, id))
    await writeAudit(tx, { actorId, now: () => at }, {
      entity: 'web_orders', entityId: id, action: status === 'cancelled' || status === 'rejected' ? 'cancel' : 'update',
      after: { status, ...(extra.reason ? { reason: extra.reason } : {}) },
    })
  })
}
