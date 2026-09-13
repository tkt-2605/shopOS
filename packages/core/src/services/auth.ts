import bcrypt from 'bcryptjs'
import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'
import { loadPermissions, type PermissionSet } from '../integrity/permissions.js'

const COST = 10
const MAX_FAILED = 5
const LOCKOUT_MINUTES = 15

export interface SessionUser {
  id: string
  username: string
  fullName: string | null
  roleId: string
  roleName: string
  permissions: PermissionSet
}

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; code: 'INVALID_CREDENTIALS' }
  | { ok: false; code: 'ACCOUNT_DISABLED' }
  | { ok: false; code: 'ACCOUNT_LOCKED'; until: string }

/**
 * A wrong password and an unknown username fail identically, and both cost a hash
 * comparison, so the response does not reveal which usernames exist.
 */
export async function login(
  db: SqlDriver,
  input: { username: string; password: string; now?: Date },
): Promise<LoginResult> {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()

  const user = await db.get<{
    id: string; username: string; full_name: string | null; role_id: string
    password_hash: string; is_active: number; failed_logins: number; locked_until: string | null
  }>(
    `SELECT id, username, full_name, role_id, password_hash, is_active, failed_logins, locked_until
       FROM users WHERE username = ? AND deleted_at IS NULL`,
    [input.username.trim().toLowerCase()],
  )

  if (!user) {
    await bcrypt.compare(input.password, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv')
    return { ok: false, code: 'INVALID_CREDENTIALS' }
  }

  if (user.locked_until && user.locked_until > nowIso) {
    return { ok: false, code: 'ACCOUNT_LOCKED', until: user.locked_until }
  }
  if (user.is_active === 0) return { ok: false, code: 'ACCOUNT_DISABLED' }

  const matches = await bcrypt.compare(input.password, user.password_hash)

  if (!matches) {
    const failed = user.failed_logins + 1
    const lockedUntil =
      failed >= MAX_FAILED ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000).toISOString() : null

    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
        [failed, lockedUntil, nowIso, user.id],
      )
      await writeAudit(tx, { actorId: user.id }, {
        entity: 'users', entityId: user.id, action: 'login_failed',
        after: { failed_logins: failed },
      })
    })

    return lockedUntil
      ? { ok: false, code: 'ACCOUNT_LOCKED', until: lockedUntil }
      : { ok: false, code: 'INVALID_CREDENTIALS' }
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?`,
      [nowIso, nowIso, user.id],
    )
    await writeAudit(tx, { actorId: user.id }, { entity: 'users', entityId: user.id, action: 'login' })
  })

  const permissions = await loadPermissions(db, user.role_id)

  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      roleId: user.role_id,
      roleName: permissions.roleName,
      permissions,
    },
  }
}

export type ReauthResult =
  | { ok: true }
  | { ok: false; code: 'WRONG_PASSWORD'; attemptsLeft: number }
  | { ok: false; code: 'ACCOUNT_LOCKED'; until: string }

/**
 * Proving again that the person at the keyboard is still the person who signed in.
 *
 * Settings and the permissions screen decide what every bill prints and who may
 * do what. A till that is signed in and left alone is the normal state of a
 * counter, so "is signed in" is not a strong enough answer for those two.
 *
 * It deliberately reuses sign-in's own rules rather than keeping a softer copy
 * of them: the same bcrypt compare, the same `failed_logins` counter, the same
 * lockout after five tries. Somebody guessing at the Settings screen is doing
 * exactly what somebody guessing at the sign-in screen is doing, and it would be
 * a strange door that counted the attempts differently.
 *
 * Recorded in the audit trail as a credential check against the user — which is
 * what it is — with `reauth` and the screen in the diff, because `audit_log`
 * carries a CHECK on its actions and rewriting an append-only table to add two
 * names to it would be a worse trade than one field.
 */
export async function reauthenticate(
  db: SqlDriver,
  input: { userId: string; password: string; scope: string; now?: Date },
): Promise<ReauthResult> {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()

  const user = await db.get<{
    id: string; password_hash: string; failed_logins: number; locked_until: string | null
  }>(
    `SELECT id, password_hash, failed_logins, locked_until
       FROM users WHERE id = ? AND deleted_at IS NULL`,
    [input.userId],
  )

  // No timing dance here, unlike `login`: the caller already knows this user
  // exists — they are signed in as them — so there is nothing to conceal.
  if (!user) return { ok: false, code: 'WRONG_PASSWORD', attemptsLeft: 0 }

  if (user.locked_until && user.locked_until > nowIso) {
    return { ok: false, code: 'ACCOUNT_LOCKED', until: user.locked_until }
  }

  if (!(await bcrypt.compare(input.password, user.password_hash))) {
    const failed = user.failed_logins + 1
    const lockedUntil =
      failed >= MAX_FAILED ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000).toISOString() : null

    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
        [failed, lockedUntil, nowIso, user.id],
      )
      await writeAudit(tx, { actorId: user.id }, {
        entity: 'users', entityId: user.id, action: 'login_failed',
        after: { reauth: 1, screen: input.scope, failed_logins: failed },
      })
    })

    return lockedUntil
      ? { ok: false, code: 'ACCOUNT_LOCKED', until: lockedUntil }
      : { ok: false, code: 'WRONG_PASSWORD', attemptsLeft: MAX_FAILED - failed }
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      [nowIso, user.id],
    )
    await writeAudit(tx, { actorId: user.id }, {
      entity: 'users', entityId: user.id, action: 'login',
      after: { reauth: 1, screen: input.scope },
    })
  })

  return { ok: true }
}

export type CreateUserResult =
  | { ok: true; userId: string }
  | { ok: false; code: 'USERNAME_TAKEN' }
  | { ok: false; code: 'WEAK_PASSWORD'; reason: string }

export async function createUser(
  db: SqlDriver,
  input: { username: string; password: string; fullName?: string; roleId: string; actorId?: string; now?: Date },
): Promise<CreateUserResult> {
  const username = input.username.trim().toLowerCase()
  const weak = passwordProblem(input.password)
  if (weak) return { ok: false, code: 'WEAK_PASSWORD', reason: weak }

  const existing = await db.get<{ id: string }>(`SELECT id FROM users WHERE username = ?`, [username])
  if (existing) return { ok: false, code: 'USERNAME_TAKEN' }

  const userId = newId()
  const nowIso = (input.now ?? new Date()).toISOString()
  const hash = await bcrypt.hash(input.password, COST)

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, username, input.fullName ?? null, input.roleId, hash, nowIso, nowIso],
    )
    await writeAudit(tx, { actorId: input.actorId ?? null }, {
      entity: 'users', entityId: userId, action: 'create',
      after: { username, role_id: input.roleId },
    })
  })

  return { ok: true, userId }
}

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; code: 'WRONG_PASSWORD' }
  | { ok: false; code: 'WEAK_PASSWORD'; reason: string }

export async function changePassword(
  db: SqlDriver,
  input: { userId: string; currentPassword: string; newPassword: string; now?: Date },
): Promise<ChangePasswordResult> {
  const weak = passwordProblem(input.newPassword)
  if (weak) return { ok: false, code: 'WEAK_PASSWORD', reason: weak }

  const user = await db.get<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = ?`, [input.userId])
  if (!user) return { ok: false, code: 'WRONG_PASSWORD' }
  if (!(await bcrypt.compare(input.currentPassword, user.password_hash))) {
    return { ok: false, code: 'WRONG_PASSWORD' }
  }

  const hash = await bcrypt.hash(input.newPassword, COST)
  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      [hash, nowIso, input.userId],
    )
    // The hash itself never reaches the audit trail.
    await writeAudit(tx, { actorId: input.userId }, {
      entity: 'users', entityId: input.userId, action: 'update', after: { password_changed: 1 },
    })
  })

  return { ok: true }
}

export async function setUserActive(
  db: SqlDriver,
  input: { userId: string; isActive: boolean; actorId: string; now?: Date },
): Promise<void> {
  const nowIso = (input.now ?? new Date()).toISOString()
  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?`, [
      input.isActive ? 1 : 0, nowIso, input.userId,
    ])
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'users', entityId: input.userId, action: 'update', after: { is_active: input.isActive ? 1 : 0 },
    })
  })
}

function passwordProblem(password: string): string | null {
  if (password.length < 6) return 'Use at least 6 characters'
  if (/^\d+$/.test(password)) return 'Use more than just digits'
  return null
}

export interface StaffMember {
  id: string
  username: string
  fullName: string | null
  roleId: string
  roleName: string
  isActive: boolean
  lastLoginAt: string | null
  lockedUntil: string | null
}

export async function listStaff(db: SqlDriver): Promise<StaffMember[]> {
  const rows = await db.query<{
    id: string; username: string; full_name: string | null; role_id: string
    role_name: string; is_active: number; last_login_at: string | null; locked_until: string | null
  }>(
    `SELECT u.id, u.username, u.full_name, u.role_id, r.name AS role_name,
            u.is_active, u.last_login_at, u.locked_until
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.deleted_at IS NULL
      ORDER BY u.is_active DESC, u.username`,
  )
  return rows.map((u) => ({
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    roleId: u.role_id,
    roleName: u.role_name,
    isActive: u.is_active === 1,
    lastLoginAt: u.last_login_at,
    lockedUntil: u.locked_until,
  }))
}

export async function updateUser(
  db: SqlDriver,
  input: { userId: string; fullName?: string | null; roleId?: string; actorId: string; now?: Date },
): Promise<void> {
  const before = await db.get<{ full_name: string | null; role_id: string }>(
    `SELECT full_name, role_id FROM users WHERE id = ?`, [input.userId],
  )
  if (!before) return

  const fullName = input.fullName === undefined ? before.full_name : (input.fullName?.trim() || null)
  const roleId = input.roleId ?? before.role_id
  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE users SET full_name = ?, role_id = ?, updated_at = ? WHERE id = ?`,
      [fullName, roleId, nowIso, input.userId])
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'users', entityId: input.userId, action: 'update',
      before: { full_name: before.full_name, role_id: before.role_id },
      after: { full_name: fullName, role_id: roleId },
    })
  })
}

/**
 * An owner resetting a forgotten password, not a user changing their own — there
 * is no current password to check, which is exactly why it is audited by actor.
 */
export async function resetPassword(
  db: SqlDriver,
  input: { userId: string; newPassword: string; actorId: string; now?: Date },
): Promise<ChangePasswordResult> {
  const weak = passwordProblem(input.newPassword)
  if (weak) return { ok: false, code: 'WEAK_PASSWORD', reason: weak }

  const hash = await bcrypt.hash(input.newPassword, COST)
  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      [hash, nowIso, input.userId],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'users', entityId: input.userId, action: 'update', after: { password_reset_by_admin: 1 },
    })
  })

  return { ok: true }
}

export async function unlockUser(
  db: SqlDriver,
  input: { userId: string; actorId: string; now?: Date },
): Promise<void> {
  const nowIso = (input.now ?? new Date()).toISOString()
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      [nowIso, input.userId],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'users', entityId: input.userId, action: 'update', after: { unlocked: 1 },
    })
  })
}
