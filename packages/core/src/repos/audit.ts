import type { SqlDriver, SqlValue } from '../db/driver.js'

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
const SUBJECT = `
  CASE a.entity
    WHEN 'bills'          THEN (SELECT doc_no FROM bills WHERE id = a.entity_id)
    WHEN 'sales_returns'  THEN (SELECT doc_no FROM sales_returns WHERE id = a.entity_id)
    WHEN 'payment_entries' THEN (SELECT doc_no FROM payment_entries WHERE id = a.entity_id)
    WHEN 'stock_entries'  THEN (SELECT doc_no FROM stock_entries WHERE id = a.entity_id)
    WHEN 'stock_counts'   THEN (SELECT doc_no FROM stock_counts WHERE id = a.entity_id)
    WHEN 'products'       THEN (SELECT name FROM products WHERE id = a.entity_id)
    WHEN 'customers'      THEN (SELECT name FROM customers WHERE id = a.entity_id)
    WHEN 'suppliers'      THEN (SELECT name FROM suppliers WHERE id = a.entity_id)
    WHEN 'users'          THEN (SELECT COALESCE(full_name, username) FROM users WHERE id = a.entity_id)
    WHEN 'roles'          THEN (SELECT name FROM roles WHERE id = a.entity_id)
    WHEN 'price_lists'    THEN (SELECT name FROM price_lists WHERE id = a.entity_id)
    WHEN 'item_prices'    THEN (SELECT p.name FROM item_prices ip JOIN products p ON p.id = ip.product_id
                                 WHERE ip.id = a.entity_id)
    WHEN 'customer_item_prices' THEN (SELECT p.name FROM customer_item_prices cp JOIN products p ON p.id = cp.product_id
                                       WHERE cp.id = a.entity_id)
    WHEN 'attachments'    THEN (SELECT file_name FROM attachments WHERE id = a.entity_id)
    ELSE NULL
  END`

export async function listAuditEntries(db: SqlDriver, filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const where: string[] = []
  const args: SqlValue[] = []

  if (filter.entity) { where.push('a.entity = ?'); args.push(filter.entity) }
  if (filter.action) { where.push('a.action = ?'); args.push(filter.action) }
  if (filter.actorId) { where.push('a.actor_id = ?'); args.push(filter.actorId) }
  if (filter.entityId) { where.push('a.entity_id = ?'); args.push(filter.entityId) }
  // Inclusive of the whole last day: a date without a time is a day, and a
  // shopkeeper asking for "up to the 13th" means the end of it.
  if (filter.from) { where.push('a.at >= ?'); args.push(filter.from) }
  if (filter.to) { where.push('a.at < ?'); args.push(`${filter.to}T99`) }

  if (filter.term?.trim()) {
    const like = `%${filter.term.trim()}%`
    where.push(`(a.entity LIKE ? OR a.action LIKE ? OR COALESCE(u.full_name, u.username) LIKE ?
                 OR COALESCE(${SUBJECT}, '') LIKE ? OR COALESCE(a.diff, '') LIKE ?)`)
    args.push(like, like, like, like, like)
  }

  const rows = await db.query<{
    id: string; at: string; entity: string; entity_id: string; action: string
    actor_id: string | null; actor_name: string | null
    docstatus_from: number | null; docstatus_to: number | null
    diff: string | null; subject: string | null
  }>(
    `SELECT a.id, a.at, a.entity, a.entity_id, a.action, a.actor_id,
            COALESCE(u.full_name, u.username) AS actor_name,
            a.docstatus_from, a.docstatus_to, a.diff,
            ${SUBJECT} AS subject
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.at DESC, a.rowid DESC
      LIMIT ? OFFSET ?`,
    [...args, filter.limit ?? 100, filter.offset ?? 0],
  )

  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    entity: r.entity,
    entityId: r.entity_id,
    action: r.action,
    actorId: r.actor_id,
    actorName: r.actor_name,
    docstatusFrom: r.docstatus_from,
    docstatusTo: r.docstatus_to,
    changes: parseDiff(r.diff),
    subject: r.subject,
  }))
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
  const rows = await db.query<{ entity: string }>(
    `SELECT DISTINCT entity FROM audit_log ORDER BY entity`,
  )
  return rows.map((r) => r.entity)
}

export async function auditActors(db: SqlDriver): Promise<{ id: string; name: string }[]> {
  const rows = await db.query<{ id: string; name: string }>(
    `SELECT DISTINCT u.id, COALESCE(u.full_name, u.username) AS name
       FROM audit_log a JOIN users u ON u.id = a.actor_id
      ORDER BY name`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name }))
}

export async function countAuditEntries(db: SqlDriver): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log`)
  return row?.n ?? 0
}
