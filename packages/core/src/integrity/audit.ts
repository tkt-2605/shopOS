import type { SqlDriver, SqlValue } from '../db/driver.js'
import { newId } from '../ids.js'
import type { DocStatus } from './docstatus.js'

export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'submit' | 'cancel' | 'amend'
  | 'login' | 'login_failed'

export interface AuditContext {
  actorId: string | null
  now?: () => string
}

export interface AuditRecord {
  entity: string
  entityId: string
  action: AuditAction
  before?: Record<string, SqlValue> | null
  after?: Record<string, SqlValue> | null
  docstatusFrom?: DocStatus | null
  docstatusTo?: DocStatus | null
}

export type FieldDiff = Record<string, { from: SqlValue; to: SqlValue }>

/**
 * Writes through the caller's transaction handle, never its own. A change that
 * rolls back must not leave an audit row claiming it happened.
 */
export async function writeAudit(tx: SqlDriver, ctx: AuditContext, record: AuditRecord): Promise<void> {
  const diff = diffFields(record.before ?? null, record.after ?? null)
  const at = (ctx.now ?? defaultNow)()

  await tx.execute(
    `INSERT INTO audit_log (id, entity, entity_id, action, actor_id, docstatus_from, docstatus_to, diff, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      record.entity,
      record.entityId,
      record.action,
      ctx.actorId,
      record.docstatusFrom ?? null,
      record.docstatusTo ?? null,
      diff === null ? null : JSON.stringify(diff),
      at,
    ],
  )
}

export async function writeActivity(
  tx: SqlDriver,
  ctx: AuditContext,
  entry: { action: string; entity?: string | null; entityId?: string | null; summary: string },
): Promise<void> {
  await tx.execute(
    `INSERT INTO activity_log (id, actor_id, action, entity, entity_id, summary, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      ctx.actorId,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.summary,
      (ctx.now ?? defaultNow)(),
    ],
  )
}

const NEVER_AUDITED = new Set(['rev', 'updated_at', 'created_at'])

export function diffFields(
  before: Record<string, SqlValue> | null,
  after: Record<string, SqlValue> | null,
): FieldDiff | null {
  if (before === null && after === null) return null

  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const diff: FieldDiff = {}

  for (const key of keys) {
    if (NEVER_AUDITED.has(key)) continue
    const from = before?.[key] ?? null
    const to = after?.[key] ?? null
    if (!sameValue(from, to)) diff[key] = { from, to }
  }

  return Object.keys(diff).length === 0 ? null : diff
}

function sameValue(a: SqlValue, b: SqlValue): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i])
  }
  return false
}

function defaultNow(): string {
  return new Date().toISOString()
}
