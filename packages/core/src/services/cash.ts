import { eq, and, isNull, isNotNull, desc, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { type Money, ZERO, add, sub, paise } from '../money.js'
import { DRAFT, SUBMITTED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'

export type CashDirection = 'in' | 'out'
export type TenderMethod = 'cash' | 'upi' | 'card' | 'credit' | 'loyalty' | 'adjustment'

export interface CashMovementInput {
  sessionId: string
  direction: CashDirection
  amount: Money
  method?: TenderMethod
  sourceType: string
  sourceId?: string | null
  reference?: string | null
  userId?: string | null
  now?: Date
}

/**
 * Every tender is recorded, but only cash moves the drawer — a UPI sale is logged
 * for reporting and deliberately excluded from the closing count.
 */
export async function postCashMovement(tx: SqlDriver, input: CashMovementInput): Promise<void> {
  if (input.amount <= 0) return

  await q(tx).insert(schema.cashMovements).values({
    id: newId(),
    sessionId: input.sessionId,
    direction: input.direction,
    amount: input.amount,
    method: input.method ?? 'cash',
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    reference: input.reference ?? null,
    createdBy: input.userId ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  })
}

export async function openSessionFor(db: SqlDriver, registerId: string): Promise<string | null> {
  const [row] = await q(db)
    .select({ id: schema.cashSessions.id })
    .from(schema.cashSessions)
    .where(and(
      eq(schema.cashSessions.registerId, registerId),
      isNull(schema.cashSessions.closedAt),
    ))
  return row?.id ?? null
}

export interface OpenSessionInput {
  registerId: string
  userId: string
  openingCash?: Money
  now?: Date
}

export async function getOrOpenSession(
  db: SqlDriver,
  input: OpenSessionInput,
): Promise<{ sessionId: string; opened: boolean }> {
  const existing = await openSessionFor(db, input.registerId)
  if (existing) return { sessionId: existing, opened: false }

  const sessionId = newId()
  const now = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.cashSessions).values({
      id: sessionId,
      registerId: input.registerId,
      docstatus: DRAFT,
      openedBy: input.userId,
      openedAt: now,
      openingCash: input.openingCash ?? ZERO,
      createdAt: now,
      updatedAt: now,
    })
    await writeAudit(tx, { actorId: input.userId }, {
      entity: 'cash_sessions', entityId: sessionId, action: 'create', docstatusTo: DRAFT,
      after: { opening_cash: input.openingCash ?? ZERO },
    })
  })

  return { sessionId, opened: true }
}

export interface SessionSummary {
  sessionId: string
  openingCash: Money
  cashIn: Money
  cashOut: Money
  expectedCash: Money
  nonCashIn: Money
  movementCount: number
}

export async function sessionSummary(db: SqlDriver, sessionId: string): Promise<SessionSummary> {
  const [session] = await q(db)
    .select({ openingCash: schema.cashSessions.openingCash })
    .from(schema.cashSessions)
    .where(eq(schema.cashSessions.id, sessionId))
  if (!session) throw new Error(`unknown cash session: ${sessionId}`)

  /* One pass over the movements, split by what each one was. Every tender is
     recorded and only cash moves the drawer, so the three sums are different
     questions and the drawer is the first two. */
  const amount = schema.cashMovements.amount
  const method = schema.cashMovements.method
  const direction = schema.cashMovements.direction

  const [totals] = await q(db)
    .select({
      cashIn: sql<Money>`COALESCE(SUM(CASE WHEN ${method} = 'cash' AND ${direction} = 'in' THEN ${amount} END), 0)`,
      cashOut: sql<Money>`COALESCE(SUM(CASE WHEN ${method} = 'cash' AND ${direction} = 'out' THEN ${amount} END), 0)`,
      nonCashIn: sql<Money>`COALESCE(SUM(CASE WHEN ${method} <> 'cash' AND ${direction} = 'in' THEN ${amount} END), 0)`,
      n: sql<number>`COUNT(*)`,
    })
    .from(schema.cashMovements)
    .where(eq(schema.cashMovements.sessionId, sessionId))

  const openingCash = session.openingCash
  const cashIn = totals?.cashIn ?? ZERO
  const cashOut = totals?.cashOut ?? ZERO

  return {
    sessionId,
    openingCash,
    cashIn,
    cashOut,
    expectedCash: sub(add(openingCash, cashIn), cashOut),
    nonCashIn: totals?.nonCashIn ?? ZERO,
    movementCount: totals?.n ?? 0,
  }
}

export interface CloseSessionResult {
  sessionId: string
  expectedCash: Money
  actualCash: Money
  variance: Money
}

export async function closeSession(
  db: SqlDriver,
  input: { sessionId: string; actualCash: Money; userId: string; notes?: string; now?: Date },
): Promise<CloseSessionResult> {
  const [session] = await q(db)
    .select({ docstatus: schema.cashSessions.docstatus })
    .from(schema.cashSessions)
    .where(eq(schema.cashSessions.id, input.sessionId))
  if (!session) throw new Error(`unknown cash session: ${input.sessionId}`)
  assertCanApply('cash session', parseDocStatus(session.docstatus), 'submit')

  const summary = await sessionSummary(db, input.sessionId)
  const variance = sub(input.actualCash, summary.expectedCash)
  const now = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.cashSessions)
      .set({
        docstatus: SUBMITTED,
        closedBy: input.userId,
        closedAt: now,
        expectedCash: summary.expectedCash,
        actualCash: input.actualCash,
        variance,
        notes: input.notes ?? null,
        updatedAt: now,
      })
      .where(eq(schema.cashSessions.id, input.sessionId))
    await writeAudit(tx, { actorId: input.userId }, {
      entity: 'cash_sessions', entityId: input.sessionId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      after: { expected_cash: summary.expectedCash, actual_cash: input.actualCash, variance },
    })
  })

  return { sessionId: input.sessionId, expectedCash: summary.expectedCash, actualCash: input.actualCash, variance }
}

export async function countDrawer(denominations: Record<string, number>): Promise<Money> {
  let total = 0
  for (const [note, count] of Object.entries(denominations)) {
    const value = Number(note)
    if (!Number.isFinite(value) || !Number.isInteger(count) || count < 0) continue
    total += value * 100 * count
  }
  return paise(total)
}

export interface ClosedSession {
  id: string
  registerId: string
  registerName: string
  openedAt: string
  openedBy: string | null
  closedAt: string
  closedBy: string | null
  openingCash: Money
  expectedCash: Money
  actualCash: Money
  /** Actual less expected. Negative is money missing, positive is money over. */
  variance: Money
  notes: string | null
  /** The day the close belongs to, for filtering by a business day. */
  postingDate: string
}

/**
 * Every drawer that has been counted and closed.
 *
 * `closeSession` has written `expected_cash`, `actual_cash` and `variance`
 * since v1 and nothing has ever read them back. A shop counting its drawer
 * every evening could see tonight's variance on the screen it was counted on,
 * and then never again -- so the question a shopkeeper actually asks, "is it
 * short on the same person's shift every week", had no answer anywhere in the
 * product.
 *
 * The date used for filtering is the *close*, not the open: a session opened at
 * 9pm and closed after midnight belongs to the night it was counted, which is
 * the evening somebody is asking about.
 *
 * Open sessions are left out. A drawer that has not been counted has no
 * variance, and a zero in that column would read as one that balanced.
 */
export async function listSessions(
  db: SqlDriver,
  range: { from: string; to: string; registerId?: string | null },
): Promise<ClosedSession[]> {
  /* `users` twice, under two names: whoever opened the drawer and whoever
     counted it are different questions and often different people, and the
     answer to "is it short on the same person's shift" needs both. */
  const openedBy = alias(schema.users, 'opened_by_user')
  const closedBy = alias(schema.users, 'closed_by_user')

  const rows = await q(db)
    .select({
      id: schema.cashSessions.id,
      registerId: schema.cashSessions.registerId,
      registerName: schema.registers.name,
      openedAt: schema.cashSessions.openedAt,
      openedBy: openedBy.username,
      closedAt: schema.cashSessions.closedAt,
      closedBy: closedBy.username,
      openingCash: schema.cashSessions.openingCash,
      expectedCash: schema.cashSessions.expectedCash,
      actualCash: schema.cashSessions.actualCash,
      variance: schema.cashSessions.variance,
      notes: schema.cashSessions.notes,
    })
    .from(schema.cashSessions)
    /* All three joins are left joins, and stay so: a register renamed out of
       existence or a cashier removed from the shop must not take the evening's
       count off the report with them. */
    .leftJoin(schema.registers, eq(schema.registers.id, schema.cashSessions.registerId))
    .leftJoin(openedBy, eq(openedBy.id, schema.cashSessions.openedBy))
    .leftJoin(closedBy, eq(closedBy.id, schema.cashSessions.closedBy))
    .where(and(
      eq(schema.cashSessions.docstatus, SUBMITTED),
      isNotNull(schema.cashSessions.closedAt),
      /* raw: the business day is the first ten characters of the close, and
         `substr` on the stored text is what the index-free comparison has
         always done. Storing a separate date column is the alternative and it
         is a migration, not a rewrite. */
      sql`substr(${schema.cashSessions.closedAt}, 1, 10) BETWEEN ${range.from} AND ${range.to}`,
      ...(range.registerId ? [eq(schema.cashSessions.registerId, range.registerId)] : []),
    ))
    .orderBy(desc(schema.cashSessions.closedAt))

  return rows.map((r) => ({
    ...r,
    registerName: r.registerName ?? 'this counter',
    closedAt: r.closedAt!,
    expectedCash: r.expectedCash ?? ZERO,
    actualCash: r.actualCash ?? ZERO,
    variance: r.variance ?? ZERO,
    postingDate: r.closedAt!.slice(0, 10),
  }))
}
