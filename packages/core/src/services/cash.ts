import type { SqlDriver } from '../db/driver.js'
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

  await tx.execute(
    `INSERT INTO cash_movements
       (id, session_id, direction, amount, method, source_type, source_id, reference, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(), input.sessionId, input.direction, input.amount, input.method ?? 'cash',
      input.sourceType, input.sourceId ?? null, input.reference ?? null,
      input.userId ?? null, (input.now ?? new Date()).toISOString(),
    ],
  )
}

export async function openSessionFor(db: SqlDriver, registerId: string): Promise<string | null> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM cash_sessions WHERE register_id = ? AND closed_at IS NULL`,
    [registerId],
  )
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
    await tx.execute(
      `INSERT INTO cash_sessions (id, register_id, docstatus, opened_by, opened_at, opening_cash, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
      [sessionId, input.registerId, input.userId, now, input.openingCash ?? ZERO, now, now],
    )
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
  const session = await db.get<{ opening_cash: number }>(
    `SELECT opening_cash FROM cash_sessions WHERE id = ?`,
    [sessionId],
  )
  if (!session) throw new Error(`unknown cash session: ${sessionId}`)

  const totals = await db.get<{ cash_in: number; cash_out: number; non_cash_in: number; n: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN method = 'cash' AND direction = 'in'  THEN amount END), 0) AS cash_in,
       COALESCE(SUM(CASE WHEN method = 'cash' AND direction = 'out' THEN amount END), 0) AS cash_out,
       COALESCE(SUM(CASE WHEN method <> 'cash' AND direction = 'in' THEN amount END), 0) AS non_cash_in,
       COUNT(*) AS n
     FROM cash_movements WHERE session_id = ?`,
    [sessionId],
  )

  const openingCash = session.opening_cash as Money
  const cashIn = (totals?.cash_in ?? 0) as Money
  const cashOut = (totals?.cash_out ?? 0) as Money

  return {
    sessionId,
    openingCash,
    cashIn,
    cashOut,
    expectedCash: sub(add(openingCash, cashIn), cashOut),
    nonCashIn: (totals?.non_cash_in ?? 0) as Money,
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
  const session = await db.get<{ docstatus: number }>(
    `SELECT docstatus FROM cash_sessions WHERE id = ?`,
    [input.sessionId],
  )
  if (!session) throw new Error(`unknown cash session: ${input.sessionId}`)
  assertCanApply('cash session', parseDocStatus(session.docstatus), 'submit')

  const summary = await sessionSummary(db, input.sessionId)
  const variance = sub(input.actualCash, summary.expectedCash)
  const now = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE cash_sessions
          SET docstatus = 1, closed_by = ?, closed_at = ?, expected_cash = ?, actual_cash = ?,
              variance = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      [input.userId, now, summary.expectedCash, input.actualCash, variance, input.notes ?? null, now, input.sessionId],
    )
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
  const scoped = range.registerId
    ? { clause: 'AND s.register_id = ?', params: [range.from, range.to, range.registerId] }
    : { clause: '', params: [range.from, range.to] }

  const rows = await db.query<{
    id: string; register_id: string; register_name: string | null
    opened_at: string; opened_by: string | null; closed_at: string; closed_by: string | null
    opening_cash: number; expected_cash: number | null; actual_cash: number | null
    variance: number | null; notes: string | null
  }>(
    `SELECT s.id, s.register_id, r.name AS register_name,
            s.opened_at, o.username AS opened_by,
            s.closed_at, c.username AS closed_by,
            s.opening_cash, s.expected_cash, s.actual_cash, s.variance, s.notes
       FROM cash_sessions s
       LEFT JOIN registers r ON r.id = s.register_id
       LEFT JOIN users o ON o.id = s.opened_by
       LEFT JOIN users c ON c.id = s.closed_by
      WHERE s.docstatus = 1 AND s.closed_at IS NOT NULL
        AND substr(s.closed_at, 1, 10) BETWEEN ? AND ? ${scoped.clause}
      ORDER BY s.closed_at DESC`,
    scoped.params,
  )

  return rows.map((r) => ({
    id: r.id,
    registerId: r.register_id,
    registerName: r.register_name ?? 'this counter',
    openedAt: r.opened_at,
    openedBy: r.opened_by,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    openingCash: r.opening_cash as Money,
    expectedCash: (r.expected_cash ?? 0) as Money,
    actualCash: (r.actual_cash ?? 0) as Money,
    variance: (r.variance ?? 0) as Money,
    notes: r.notes,
    postingDate: r.closed_at.slice(0, 10),
  }))
}
