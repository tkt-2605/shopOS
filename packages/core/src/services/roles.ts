import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'
import { checkLinks } from '../integrity/links.js'
import {
  RESOURCES, PAGES, noPermissions, fullPermissions,
  type Resource, type Page, type ResourcePermissions,
} from '../integrity/permissions.js'

/**
 * Roles are data, not code. The owner adds a role, ticks what it may do and which
 * pages it sees, and the sidebar, the route guard and the service gate all follow
 * from the same two tables.
 */

export interface RoleSummary {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  userCount: number
}

export interface RoleMatrix {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  resources: Record<Resource, ResourcePermissions>
  pages: Record<Page, boolean>
}

export async function listRoles(db: SqlDriver): Promise<RoleSummary[]> {
  const rows = await db.query<{
    id: string; name: string; description: string | null; is_system: number; n: number
  }>(
    `SELECT r.id, r.name, r.description, r.is_system,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS n
       FROM roles r
      ORDER BY r.is_system DESC, r.name`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isSystem: r.is_system === 1,
    userCount: r.n,
  }))
}

export async function loadRoleMatrix(db: SqlDriver, roleId: string): Promise<RoleMatrix | null> {
  const role = await db.get<{ id: string; name: string; description: string | null; is_system: number }>(
    `SELECT id, name, description, is_system FROM roles WHERE id = ?`,
    [roleId],
  )
  if (!role) return null

  const permRows = await db.query<{
    resource: string
    can_read: number; can_create: number; can_write: number
    can_delete: number; can_submit: number; can_cancel: number; can_amend: number
  }>(`SELECT * FROM role_permissions WHERE role_id = ?`, [roleId])

  const resources = Object.fromEntries(RESOURCES.map((r) => [r, noPermissions()])) as Record<Resource, ResourcePermissions>
  for (const row of permRows) {
    if (!RESOURCES.includes(row.resource as Resource)) continue
    resources[row.resource as Resource] = {
      read: !!row.can_read,
      create: !!row.can_create,
      write: !!row.can_write,
      delete: !!row.can_delete,
      submit: !!row.can_submit,
      cancel: !!row.can_cancel,
      amend: !!row.can_amend,
    }
  }

  const pageRows = await db.query<{ page_key: string; visible: number }>(
    `SELECT page_key, visible FROM role_pages WHERE role_id = ?`, [roleId],
  )
  const seen = new Map(pageRows.map((p) => [p.page_key, p.visible === 1]))
  const pages = Object.fromEntries(PAGES.map((p) => [p, seen.get(p) ?? false])) as Record<Page, boolean>

  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.is_system === 1,
    resources,
    pages,
  }
}

export type RoleResult =
  | { ok: true; roleId: string }
  | { ok: false; code: 'NAME_TAKEN' }
  | { ok: false; code: 'WOULD_LOCK_OUT' }

export async function createRole(
  db: SqlDriver,
  input: { name: string; description?: string; copyFromId?: string; actorId: string },
): Promise<RoleResult> {
  const name = input.name.trim()
  const clash = await db.get<{ id: string }>(`SELECT id FROM roles WHERE name = ?`, [name])
  if (clash) return { ok: false, code: 'NAME_TAKEN' }

  const source = input.copyFromId ? await loadRoleMatrix(db, input.copyFromId) : null
  const roleId = newId()
  const now = new Date().toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO roles (id, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
      [roleId, name, input.description?.trim() || null, now, now],
    )
    if (source) {
      await writeMatrix(tx, roleId, source.resources, source.pages)
    }
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'roles', entityId: roleId, action: 'create',
      after: { name, copied_from: source?.name ?? null },
    })
  })

  return { ok: true, roleId }
}

export async function renameRole(
  db: SqlDriver,
  input: { roleId: string; name: string; description?: string; actorId: string },
): Promise<RoleResult> {
  const name = input.name.trim()
  const clash = await db.get<{ id: string }>(
    `SELECT id FROM roles WHERE name = ? AND id <> ?`, [name, input.roleId],
  )
  if (clash) return { ok: false, code: 'NAME_TAKEN' }

  const before = await db.get<{ name: string; description: string | null }>(
    `SELECT name, description FROM roles WHERE id = ?`, [input.roleId],
  )

  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
      [name, input.description?.trim() || null, new Date().toISOString(), input.roleId])
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'roles', entityId: input.roleId, action: 'update',
      before: before ? { name: before.name, description: before.description } : null,
      after: { name, description: input.description?.trim() || null },
    })
  })

  return { ok: true, roleId: input.roleId }
}

/**
 * Saves the whole grid at once. Partial saves would let a role sit in a state the
 * owner never chose — half a permission set is worse than an unsaved one.
 */
export async function saveRoleMatrix(
  db: SqlDriver,
  input: {
    roleId: string
    resources: Record<Resource, ResourcePermissions>
    pages: Record<Page, boolean>
    actorId: string
  },
): Promise<RoleResult> {
  try {
    await db.transaction(async (tx) => {
      await writeMatrix(tx, input.roleId, input.resources, input.pages)
      await assertSomeoneCanAdminister(tx)
      await tx.execute(`UPDATE roles SET updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), input.roleId])
      await writeAudit(tx, { actorId: input.actorId }, {
        entity: 'roles', entityId: input.roleId, action: 'update',
        after: { permissions_changed: 1 },
      })
    })
  } catch (err) {
    if (err instanceof LockoutError) return { ok: false, code: 'WOULD_LOCK_OUT' }
    throw err
  }
  return { ok: true, roleId: input.roleId }
}

export type DeleteRoleResult =
  | { ok: true }
  | { ok: false; code: 'IN_USE'; message: string }
  | { ok: false; code: 'SYSTEM_ROLE' }
  | { ok: false; code: 'WOULD_LOCK_OUT' }

export async function deleteRole(
  db: SqlDriver,
  input: { roleId: string; actorId: string },
): Promise<DeleteRoleResult> {
  const role = await db.get<{ name: string; is_system: number }>(
    `SELECT name, is_system FROM roles WHERE id = ?`, [input.roleId],
  )
  if (!role) return { ok: true }
  if (role.is_system === 1) return { ok: false, code: 'SYSTEM_ROLE' }

  const links = await checkLinks(db, 'roles', input.roleId)
  if (!links.deletable) {
    const ref = links.references[0]!
    return {
      ok: false,
      code: 'IN_USE',
      message: ref.example
        ? `${ref.count} ${ref.label} still use this role, including ${ref.example}.`
        : `${ref.count} ${ref.label} still use this role.`,
    }
  }

  try {
    await db.transaction(async (tx) => {
      // role_permissions and role_pages cascade; the role row itself goes for good
      // because nothing references it any more.
      await tx.execute(`DELETE FROM roles WHERE id = ?`, [input.roleId])
      await assertSomeoneCanAdminister(tx)
      await writeAudit(tx, { actorId: input.actorId }, {
        entity: 'roles', entityId: input.roleId, action: 'delete', before: { name: role.name },
      })
    })
  } catch (err) {
    if (err instanceof LockoutError) return { ok: false, code: 'WOULD_LOCK_OUT' }
    throw err
  }

  return { ok: true }
}

async function writeMatrix(
  tx: SqlDriver,
  roleId: string,
  resources: Record<Resource, ResourcePermissions>,
  pages: Record<Page, boolean>,
): Promise<void> {
  for (const resource of RESOURCES) {
    const p = resources[resource] ?? noPermissions()
    await tx.execute(
      `INSERT INTO role_permissions
         (id, role_id, resource, can_read, can_create, can_write, can_delete, can_submit, can_cancel, can_amend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (role_id, resource) DO UPDATE SET
         can_read = excluded.can_read, can_create = excluded.can_create,
         can_write = excluded.can_write, can_delete = excluded.can_delete,
         can_submit = excluded.can_submit, can_cancel = excluded.can_cancel,
         can_amend = excluded.can_amend`,
      [
        newId(), roleId, resource,
        bit(p.read), bit(p.create), bit(p.write),
        bit(p.delete), bit(p.submit), bit(p.cancel), bit(p.amend),
      ],
    )
  }

  for (const page of PAGES) {
    await tx.execute(
      `INSERT INTO role_pages (role_id, page_key, visible) VALUES (?, ?, ?)
       ON CONFLICT (role_id, page_key) DO UPDATE SET visible = excluded.visible`,
      [roleId, page, bit(pages[page] ?? false)],
    )
  }
}

class LockoutError extends Error {}

/**
 * A shop that ticks away its own last administrator has no way back in without a
 * developer. The check runs inside the transaction, so the save that would cause
 * it rolls back rather than being reported after the fact.
 */
async function assertSomeoneCanAdminister(tx: SqlDriver): Promise<void> {
  const row = await tx.get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id AND rp.resource = 'role' AND rp.can_write = 1
       JOIN role_pages pg ON pg.role_id = u.role_id AND pg.page_key = 'roles' AND pg.visible = 1
      WHERE u.is_active = 1`,
  )
  if ((row?.n ?? 0) === 0) throw new LockoutError()
}

/** Exposed so the staff screen can apply the same guard before it disables a user. */
export async function wouldLeaveNoAdministrator(
  db: SqlDriver,
  change: { userId: string; roleId?: string; isActive?: boolean },
): Promise<boolean> {
  const rows = await db.query<{ id: string; role_id: string; is_active: number }>(
    `SELECT id, role_id, is_active FROM users`,
  )
  const admins = await db.query<{ role_id: string }>(
    `SELECT rp.role_id
       FROM role_permissions rp
       JOIN role_pages pg ON pg.role_id = rp.role_id AND pg.page_key = 'roles' AND pg.visible = 1
      WHERE rp.resource = 'role' AND rp.can_write = 1`,
  )
  const adminRoles = new Set(admins.map((a) => a.role_id))

  const after = rows.map((u) =>
    u.id === change.userId
      ? {
          role_id: change.roleId ?? u.role_id,
          is_active: change.isActive === undefined ? u.is_active : change.isActive ? 1 : 0,
        }
      : { role_id: u.role_id, is_active: u.is_active },
  )

  return !after.some((u) => u.is_active === 1 && adminRoles.has(u.role_id))
}

export { fullPermissions, noPermissions }

function bit(b: boolean): number {
  return b ? 1 : 0
}
