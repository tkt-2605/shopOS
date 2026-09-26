import { eq, and, ne, desc, count } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
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
  const rows = await q(db)
    .select({
      id: schema.roles.id,
      name: schema.roles.name,
      description: schema.roles.description,
      isSystem: schema.roles.isSystem,
      /* A left join, so a role nobody holds still appears with a count of
         zero -- which is most of the screen when the owner has just made one. */
      userCount: count(schema.users.id),
    })
    .from(schema.roles)
    .leftJoin(schema.users, eq(schema.users.roleId, schema.roles.id))
    .groupBy(schema.roles.id)
    .orderBy(desc(schema.roles.isSystem), schema.roles.name)

  return rows.map((r) => ({ ...r, isSystem: r.isSystem === 1 }))
}

export async function loadRoleMatrix(db: SqlDriver, roleId: string): Promise<RoleMatrix | null> {
  const [role] = await q(db)
    .select({
      id: schema.roles.id,
      name: schema.roles.name,
      description: schema.roles.description,
      isSystem: schema.roles.isSystem,
    })
    .from(schema.roles)
    .where(eq(schema.roles.id, roleId))
  if (!role) return null

  const permRows = await q(db)
    .select()
    .from(schema.rolePermissions)
    .where(eq(schema.rolePermissions.roleId, roleId))

  /* Every resource, ticked or not, and only the ones this build knows about: a
     row for a resource that has since been removed is ignored rather than
     handed to a screen that has no column for it. */
  const resources = Object.fromEntries(RESOURCES.map((r) => [r, noPermissions()])) as Record<Resource, ResourcePermissions>
  for (const row of permRows) {
    if (!RESOURCES.includes(row.resource as Resource)) continue
    resources[row.resource as Resource] = {
      read: !!row.canRead,
      create: !!row.canCreate,
      write: !!row.canWrite,
      delete: !!row.canDelete,
      submit: !!row.canSubmit,
      cancel: !!row.canCancel,
      amend: !!row.canAmend,
    }
  }

  const pageRows = await q(db)
    .select({ pageKey: schema.rolePages.pageKey, visible: schema.rolePages.visible })
    .from(schema.rolePages)
    .where(eq(schema.rolePages.roleId, roleId))
  const seen = new Map(pageRows.map((p) => [p.pageKey, p.visible === 1]))
  const pages = Object.fromEntries(PAGES.map((p) => [p, seen.get(p) ?? false])) as Record<Page, boolean>

  return { ...role, isSystem: role.isSystem === 1, resources, pages }
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
  const [clash] = await q(db)
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.name, name))
  if (clash) return { ok: false, code: 'NAME_TAKEN' }

  const source = input.copyFromId ? await loadRoleMatrix(db, input.copyFromId) : null
  const roleId = newId()
  const now = new Date().toISOString()

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.roles).values({
      id: roleId,
      name,
      description: input.description?.trim() || null,
      isSystem: 0,
      createdAt: now,
      updatedAt: now,
    })
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
  const [clash] = await q(db)
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.name, name), ne(schema.roles.id, input.roleId)))
  if (clash) return { ok: false, code: 'NAME_TAKEN' }

  const [before] = await q(db)
    .select({ name: schema.roles.name, description: schema.roles.description })
    .from(schema.roles)
    .where(eq(schema.roles.id, input.roleId))

  await db.transaction(async (tx) => {
    await q(tx).update(schema.roles)
      .set({
        name,
        description: input.description?.trim() || null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.roles.id, input.roleId))
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
      await q(tx).update(schema.roles)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(schema.roles.id, input.roleId))
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
  const [role] = await q(db)
    .select({ name: schema.roles.name, isSystem: schema.roles.isSystem })
    .from(schema.roles)
    .where(eq(schema.roles.id, input.roleId))
  if (!role) return { ok: true }
  if (role.isSystem === 1) return { ok: false, code: 'SYSTEM_ROLE' }

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
      await q(tx).delete(schema.roles).where(eq(schema.roles.id, input.roleId))
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
    const ticks = {
      canRead: bit(p.read),
      canCreate: bit(p.create),
      canWrite: bit(p.write),
      canDelete: bit(p.delete),
      canSubmit: bit(p.submit),
      canCancel: bit(p.cancel),
      canAmend: bit(p.amend),
    }
    /* The update sets the same values the insert carried, rather than reading
       them back out of `excluded`: they are already here, and one list is
       easier to keep true than two that have to say the same thing. */
    await q(tx).insert(schema.rolePermissions)
      .values({ id: newId(), roleId, resource, ...ticks })
      .onConflictDoUpdate({
        target: [schema.rolePermissions.roleId, schema.rolePermissions.resource],
        set: ticks,
      })
  }

  for (const page of PAGES) {
    const visible = bit(pages[page] ?? false)
    await q(tx).insert(schema.rolePages)
      .values({ roleId, pageKey: page, visible })
      .onConflictDoUpdate({
        target: [schema.rolePages.roleId, schema.rolePages.pageKey],
        set: { visible },
      })
  }
}

class LockoutError extends Error {}

/**
 * A shop that ticks away its own last administrator has no way back in without a
 * developer. The check runs inside the transaction, so the save that would cause
 * it rolls back rather than being reported after the fact.
 */
async function assertSomeoneCanAdminister(tx: SqlDriver): Promise<void> {
  const [row] = await q(tx)
    .select({ n: count() })
    .from(schema.users)
    .innerJoin(schema.rolePermissions, and(
      eq(schema.rolePermissions.roleId, schema.users.roleId),
      eq(schema.rolePermissions.resource, 'role'),
      eq(schema.rolePermissions.canWrite, 1),
    ))
    .innerJoin(schema.rolePages, and(
      eq(schema.rolePages.roleId, schema.users.roleId),
      eq(schema.rolePages.pageKey, 'roles'),
      eq(schema.rolePages.visible, 1),
    ))
    .where(eq(schema.users.isActive, 1))
  if ((row?.n ?? 0) === 0) throw new LockoutError()
}

/** Exposed so the staff screen can apply the same guard before it disables a user. */
export async function wouldLeaveNoAdministrator(
  db: SqlDriver,
  change: { userId: string; roleId?: string; isActive?: boolean },
): Promise<boolean> {
  const rows = await q(db)
    .select({
      id: schema.users.id,
      roleId: schema.users.roleId,
      isActive: schema.users.isActive,
    })
    .from(schema.users)

  const admins = await q(db)
    .select({ roleId: schema.rolePermissions.roleId })
    .from(schema.rolePermissions)
    .innerJoin(schema.rolePages, and(
      eq(schema.rolePages.roleId, schema.rolePermissions.roleId),
      eq(schema.rolePages.pageKey, 'roles'),
      eq(schema.rolePages.visible, 1),
    ))
    .where(and(
      eq(schema.rolePermissions.resource, 'role'),
      eq(schema.rolePermissions.canWrite, 1),
    ))
  const adminRoles = new Set(admins.map((a) => a.roleId))

  const after = rows.map((u) =>
    u.id === change.userId
      ? {
          roleId: change.roleId ?? u.roleId,
          isActive: change.isActive === undefined ? u.isActive : change.isActive ? 1 : 0,
        }
      : { roleId: u.roleId, isActive: u.isActive },
  )

  return !after.some((u) => u.isActive === 1 && adminRoles.has(u.roleId))
}

export { fullPermissions, noPermissions }

function bit(b: boolean): number {
  return b ? 1 : 0
}
