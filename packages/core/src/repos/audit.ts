import { eq, and, or, like, gte, lt, desc, count, sql, type SQL } from 'drizzle-orm'
import type { SqlDriver, SqlValue } from '../db/driver.js'
import { q, schema } from '../db/q.js'

/**
 * Reading the trail back.
 *
 * Every service in the product writes an audit row inside the same transaction
 * as the change it describes, so the log cannot claim something that did not
 * happen and cannot miss something that did. Until now nothing read it: the shop
 * had a complete history and no way to look at it.
 *
 * This is the answer to "who changed the price of this", "when did that bill get
 * cancelled and by whom", and the awkward one — "I did not do that".
 */

export interface FieldChange {
  field: string
  from: SqlValue
  to: SqlValue
}

export interface AuditEntry {
  id: string
  at: string
  entity: string
  entityId: string
  action: string
  actorId: string | null
  actorName: string | null
  docstatusFrom: number | null
  docstatusTo: number | null
  changes: FieldChange[]
  /** What the document is called, when it has a name a person would recognise. */
  subject: string | null
}

export interface AuditFilter {
  /** Substring against the entity, action, actor name or subject. */
  term?: string
  entity?: string
  action?: string
  actorId?: string
  /** Everything that happened to one record, which is the commonest question. */
  entityId?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

/**
 * The names a person would recognise, per entity.
 *
 * Joined rather than stored on the row: a bill's number is on the bill, and
 * copying it into the log would be one more thing to keep in step. The cost is a
 * handful of left joins on a screen nobody keeps open.
 */
/* raw: thirteen scalar subqueries chosen between by the entity of the row
   being read. `audit_log.entity_id` is written out in each, because a bare
   `entity_id` inside them would bind to the table being looked in. */
const SUBJECT = sql<string | null>`
  CASE audit_log.entity
    WHEN 'bills'          THEN (SELECT doc_no FROM bills WHERE id = audit_log.entity_id)
    WHEN 'sales_returns'  THEN (SELECT doc_no FROM sales_returns WHERE id = audit_log.entity_id)
    WHEN 'payment_entries' THEN (SELECT doc_no FROM payment_entries WHERE id = audit_log.entity_id)
    WHEN 'stock_entries'  THEN (SELECT doc_no FROM stock_entries WHERE id = audit_log.entity_id)
    WHEN 'stock_counts'   THEN (SELECT doc_no FROM stock_counts WHERE id = audit_log.entity_id)
    WHEN 'products'       THEN (SELECT name FROM products WHERE id = audit_log.entity_id)
    WHEN 'customers'      THEN (SELECT name FROM customers WHERE id = audit_log.entity_id)
    WHEN 'suppliers'      THEN (SELECT name FROM suppliers WHERE id = audit_log.entity_id)
    WHEN 'users'          THEN (SELECT COALESCE(full_name, username) FROM users WHERE id = audit_log.entity_id)
    WHEN 'roles'          THEN (SELECT name FROM roles WHERE id = audit_log.entity_id)
    WHEN 'price_lists'    THEN (SELECT name FROM price_lists WHERE id = audit_log.entity_id)
    WHEN 'item_prices'    THEN (SELECT p.name FROM item_prices ip JOIN products p ON p.id = ip.product_id
                                 WHERE ip.id = audit_log.entity_id)
    WHEN 'customer_item_prices' THEN (SELECT p.name FROM customer_item_prices cp JOIN products p ON p.id = cp.product_id
                                       WHERE cp.id = audit_log.entity_id)
    WHEN 'attachments'    THEN (SELECT file_name FROM attachments WHERE id = audit_log.entity_id)
    ELSE NULL
  END`

/** Who did it, which is their full name when they have one. */
const ACTOR_NAME = sql<string | null>`COALESCE(${schema.users.fullName}, ${schema.users.username})`

export async function listAuditEntries(db: SqlDriver, filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const where: SQL[] = []

  if (filter.entity) where.push(eq(schema.auditLog.entity, filter.entity))
  if (filter.action) where.push(eq(schema.auditLog.action, filter.action))
  if (filter.actorId) where.push(eq(schema.auditLog.actorId, filter.actorId))
  if (filter.entityId) where.push(eq(schema.auditLog.entityId, filter.entityId))
  // Inclusive of the whole last day: a date without a time is a day, and a
  // shopkeeper asking for "up to the 13th" means the end of it.
  if (filter.from) where.push(gte(schema.auditLog.at, filter.from))
  if (filter.to) where.push(lt(schema.auditLog.at, `${filter.to}T99`))

  if (filter.term?.trim()) {
    const anywhere = `%${filter.term.trim()}%`
    where.push(or(
      like(schema.auditLog.entity, anywhere),
      like(schema.auditLog.action, anywhere),
      like(ACTOR_NAME, anywhere),
      // `COALESCE`, because a row whose subject is null must not make the
      // whole condition null and drop out of a search it matched on action.
      like(sql`COALESCE(${SUBJECT}, '')`, anywhere),
      like(sql`COALESCE(${schema.auditLog.diff}, '')`, anywhere),
    )!)
  }

  const rows = await q(db)
    .select({
      id: schema.auditLog.id,
      at: schema.auditLog.at,
      entity: schema.auditLog.entity,
      entityId: schema.auditLog.entityId,
      action: schema.auditLog.action,
      actorId: schema.auditLog.actorId,
      actorName: ACTOR_NAME,
      docstatusFrom: schema.auditLog.docstatusFrom,
      docstatusTo: schema.auditLog.docstatusTo,
      diff: schema.auditLog.diff,
      subject: SUBJECT,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
    .where(and(...where))
    /* raw: `rowid`, which is not a column and so is not in the schema. It is
       the tiebreak between two rows written in the same millisecond, and
       without it they come back in whatever order the plan happens to give --
       which on a page of a history is a page that shuffles as it is scrolled. */
    .orderBy(desc(schema.auditLog.at), sql`audit_log.rowid DESC`)
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0)

  return rows.map((r) => ({ ...r, changes: parseDiff(r.diff) }))
}

function parseDiff(raw: string | null): FieldChange[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Record<string, { from: SqlValue; to: SqlValue }>
    return Object.entries(parsed).map(([field, change]) => ({ field, from: change.from, to: change.to }))
  } catch {
    // A log row that cannot be read is still a row that says something happened.
    return []
  }
}

/** The entities that actually appear, for a filter that offers only real choices. */
export async function auditEntities(db: SqlDriver): Promise<string[]> {
  const rows = await q(db)
    .selectDistinct({ entity: schema.auditLog.entity })
    .from(schema.auditLog)
    .orderBy(schema.auditLog.entity)
  return rows.map((r) => r.entity)
}

export async function auditActors(db: SqlDriver): Promise<{ id: string; name: string }[]> {
  const rows = await q(db)
    .selectDistinct({ id: schema.users.id, name: ACTOR_NAME })
    .from(schema.auditLog)
    .innerJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
    .orderBy(ACTOR_NAME)
  return rows.map((r) => ({ id: r.id, name: r.name ?? '' }))
}

export async function countAuditEntries(db: SqlDriver): Promise<number> {
  const [row] = await q(db).select({ n: count() }).from(schema.auditLog)
  return row?.n ?? 0
}
