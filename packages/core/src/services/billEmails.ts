import { and, asc, eq, gte, isNotNull, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import { tillRole } from './sync/layout.js'

/*
 * Bills emailed to the customers the shop has chosen (073).
 *
 * A customer with "Email every bill" ticked has every bill rung for them from
 * that moment on mailed to their address, as the shop's own A4 invoice. The
 * main till sends them all: every counter's bills reach it within a minute, so
 * the shop sets its mail up once, on one machine, and no two tills can mail the
 * same bill. `bill_emails` is the main's note of what it has queued, so a bill
 * goes once however many times the main is restarted.
 *
 * Nothing here touches the network. The app renders each bill and hands it to
 * Rust's outbox, which holds it until the mail server takes it.
 */

export interface BillToEmail {
  billId: string
  docNo: string
  grandTotal: Money
  customerName: string
  to: string
}

/** Whether this till is the one that sends: the main, or a till on its own. */
export async function sendsBillEmails(db: SqlDriver): Promise<boolean> {
  const role = await tillRole(db)
  return role === 'main' || role === 'alone'
}

/**
 * Submitted bills for chosen customers, rung since they were chosen, that this
 * till has not queued yet. Oldest first, so an outage drains in order.
 */
export async function billsToEmail(
  db: SqlDriver,
  limit = 10,
  /**
   * Bills rung before this are left alone: when this till took on sending.
   * A till newly made the main has noted none of the old main's sends, and
   * without it would mail every customer every bill since their tick again.
   */
  notBefore: string | null = null,
): Promise<BillToEmail[]> {
  const rows = await q(db)
    .select({
      billId: schema.bills.id,
      docNo: schema.bills.docNo,
      grandTotal: schema.bills.grandTotal,
      customerName: schema.customers.name,
      to: schema.customers.email,
    })
    .from(schema.bills)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.bills.customerId))
    .leftJoin(schema.billEmails, eq(schema.billEmails.billId, schema.bills.id))
    .where(and(
      eq(schema.bills.docstatus, SUBMITTED),
      eq(schema.bills.kind, 'sale'),
      isNotNull(schema.customers.email),
      isNotNull(schema.customers.emailBillsSince),
      gte(schema.bills.createdAt, schema.customers.emailBillsSince),
      ...(notBefore === null ? [] : [gte(schema.bills.createdAt, notBefore)]),
      isNull(schema.billEmails.billId),
    ))
    .orderBy(asc(schema.bills.createdAt))
    .limit(limit)
  return rows.map((r) => ({ ...r, grandTotal: r.grandTotal as Money, to: r.to! }))
}

/**
 * Notes a bill as handed over. With an `error` it was not -- the invoice would
 * not render, say -- and it is not tried again by itself: a bill that fails to
 * render fails the same way next time, and the note says why.
 */
export async function noteBillEmail(
  db: SqlDriver,
  input: { billId: string; to: string; error?: string | null; now?: string },
): Promise<void> {
  const at = input.now ?? new Date().toISOString()
  await q(db).insert(schema.billEmails)
    .values({ billId: input.billId, toAddress: input.to, queuedAt: at, error: input.error ?? null })
    .onConflictDoUpdate({
      target: schema.billEmails.billId,
      set: { toAddress: input.to, queuedAt: at, error: input.error ?? null },
    })
}

/**
 * The address a bill is due to go to, when it is due and this till has not
 * queued it: a ticked customer's bill, rung since the tick. Null otherwise.
 * For saying on the bill why it has not gone yet.
 */
export async function billDueForEmail(db: SqlDriver, billId: string): Promise<string | null> {
  const [row] = await q(db)
    .select({ to: schema.customers.email })
    .from(schema.bills)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.bills.customerId))
    .leftJoin(schema.billEmails, eq(schema.billEmails.billId, schema.bills.id))
    .where(and(
      eq(schema.bills.id, billId),
      eq(schema.bills.docstatus, SUBMITTED),
      eq(schema.bills.kind, 'sale'),
      isNotNull(schema.customers.email),
      isNotNull(schema.customers.emailBillsSince),
      gte(schema.bills.createdAt, schema.customers.emailBillsSince),
      isNull(schema.billEmails.billId),
    ))
  return row?.to ?? null
}

export interface BillEmailNote { to: string; at: string; error: string | null }

/** What this till did with one bill's email, or null when nothing. */
export async function billEmailNote(db: SqlDriver, billId: string): Promise<BillEmailNote | null> {
  const [row] = await q(db)
    .select({ to: schema.billEmails.toAddress, at: schema.billEmails.queuedAt, error: schema.billEmails.error })
    .from(schema.billEmails)
    .where(eq(schema.billEmails.billId, billId))
  return row ?? null
}

/** Takes a bill's note away, so the main tries it again on its next pass. */
export async function retryBillEmail(db: SqlDriver, billId: string): Promise<void> {
  await q(db).delete(schema.billEmails).where(eq(schema.billEmails.billId, billId))
}
