import bcrypt from 'bcryptjs'
import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'
import { loadPermissions, type PermissionSet } from '../integrity/permissions.js'

const COST = 10

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

  if (user.is_active === 0) return { ok: false, code: 'ACCOUNT_DISABLED' }

  const matches = await bcrypt.compare(input.password, user.password_hash)

  if (!matches) {
    /* Counted, never acted on. A shop with one till and one owner has no
       help desk to ring at seven in the morning, so an account that locks
       itself is a shop that cannot open — which is a worse outcome than a
       slow guess against a password only reachable by someone standing at
       the counter. The count stays because "this account was guessed at
       forty times on Tuesday" is worth being able to see. */
    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE users SET failed_logins = failed_logins + 1, updated_at = ? WHERE id = ?`,
        [nowIso, user.id],
      )
      await writeAudit(tx, { actorId: user.id }, {
        entity: 'users', entityId: user.id, action: 'login_failed',
        after: { failed_logins: user.failed_logins + 1 },
      })
    })

    return { ok: false, code: 'INVALID_CREDENTIALS' }
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
  | { ok: false; code: 'WRONG_PASSWORD' }

/**
 * Proving again that the person at the keyboard is still the person who signed in.
 *
 * Settings and the permissions screen decide what every bill prints and who may
 * do what. A till that is signed in and left alone is the normal state of a
 * counter, so "is signed in" is not a strong enough answer for those two.
 *
 * A wrong answer here counts for nothing and locks nothing. That is a different
 * rule from the sign-in screen on purpose: this door is only ever reached by
 * somebody already signed in at the counter, so counting their attempts guards
 * against nothing a locked front door does not already cover — and locking the
 * owner out of their own Settings screen mid-job, on a machine they are already
 * signed in to, is the kind of thing that gets a gate switched off.
 *
 * Every attempt is still recorded, which is the part that answers "who changed
 * the receipt on Tuesday". Written as a credential check against the user —
 * which is what it is — with `reauth` and the screen in the diff, because
 * `audit_log` carries a CHECK on its actions and rewriting an append-only table
 * to add two names to it would be a worse trade than one field.
 */
export async function reauthenticate(
  db: SqlDriver,
  input: { userId: string; password: string; scope: string; now?: Date },
): Promise<ReauthResult> {
  const nowIso = (input.now ?? new Date()).toISOString()

  const user = await db.get<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM users WHERE id = ? AND deleted_at IS NULL`,
    [input.userId],
  )

  // No timing dance here, unlike `login`: the caller already knows this user
  // exists — they are signed in as them — so there is nothing to conceal.
  if (!user) return { ok: false, code: 'WRONG_PASSWORD' }

  const right = await bcrypt.compare(input.password, user.password_hash)

  /* The counter is deliberately left alone in both directions: a wrong answer
     does not raise `failed_logins`, and a right one does not clear it. Whatever
     the sign-in screen has recorded stays exactly as the sign-in screen left
     it, so unlocking Settings cannot wipe the evidence of somebody guessing at
     the front door. */
  await db.transaction(async (tx) => {
    await writeAudit(tx, { actorId: user.id }, {
      entity: 'users',
      entityId: user.id,
      action: right ? 'login' : 'login_failed',
      after: { reauth: 1, screen: input.scope, at: nowIso },
    })
  })

  return right ? { ok: true } : { ok: false, code: 'WRONG_PASSWORD' }
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
  /**
   * Sign-ins that got the password wrong since the last one that worked.
   *
   * Shown rather than acted on: nothing locks an account, so this is the number
   * an owner watches to notice somebody working through guesses at their till.
   */
  failedLogins: number
}

export async function listStaff(db: SqlDriver): Promise<StaffMember[]> {
  const rows = await db.query<{
    id: string; username: string; full_name: string | null; role_id: string
    role_name: string; is_active: number; last_login_at: string | null; failed_logins: number
  }>(
    `SELECT u.id, u.username, u.full_name, u.role_id, r.name AS role_name,
            u.is_active, u.last_login_at, u.failed_logins
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
    failedLogins: u.failed_logins,
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

/**
 * Clears the run of failed sign-ins on an account.
 *
 * Nothing locks an account any more, so this no longer lets anybody back in —
 * it resets the count, which is how an owner says "I know about those, they
 * were mine" and gets a clean number to watch from. Old databases can still
 * carry a `locked_until` from before the lockout was removed, and this clears
 * that too.
 */
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
