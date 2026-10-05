import bcrypt from 'bcryptjs'
import { eq, and, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId, derivedId } from '../ids.js'
import { deviceId } from '../device.js'
import { writeAudit } from '../integrity/audit.js'
import { loadPermissions, type PermissionSet, requirePermission } from '../integrity/permissions.js'

const COST = 10

/**
 * A real hash at `COST`, compared against when the username does not exist so
 * that an unknown name takes as long to refuse as a wrong password.
 *
 * It has to be well formed. bcryptjs answers a malformed hash at once without
 * hashing anything -- the placeholder this replaces was 59 characters, so an
 * unknown name was refused in a millisecond and a real one in eighty, which is
 * the difference the comparison exists to hide.
 */
const TIMING_HASH = '$2b$10$XP4LmzqCjw6Fd7rdX4pvYOC.r20r88wPMQ1.MeSQuavmZGee35Qt.'

export interface SessionUser {
  id: string
  username: string
  fullName: string | null
  roleId: string
  roleName: string
  permissions: PermissionSet
}

/**
 * This till's row for one user, created the first time it is needed.
 *
 * A sign-in is a fact about a machine, and before migration 049 it was
 * written onto the `users` row, which replicates. Two counters switched on
 * within one sync round of each other each raised that row's revision before
 * either had told the other, so the merge filed a conflict saying an edit was
 * being dropped -- every morning, over a login timestamp.
 *
 * The id is derived from the user and this till together, so no two tills ever
 * write the same row and there is nothing for the merge to settle. The rows
 * still travel: the Staff screen wants the latest sign-in anywhere in the shop
 * and the total of the wrong passwords, and both of those are questions about
 * the shop rather than about one counter.
 *
 * Returns null when this machine has no identity. `establishDevice` runs before
 * the first sign-in and says why, but it can fail, and a till that cannot say
 * which machine it is still has somebody typing wrong passwords at it. So the
 * callers fall back to the `users` row, which is what they did before 049 --
 * the shared count, the occasional conflict, and a number that is at least
 * there. It is the better trade on a till that is already broken in a way the
 * startup screen has reported.
 */
async function sessionRow(
  tx: SqlDriver, userId: string, nowIso: string,
): Promise<string | null> {
  const device = deviceId()
  if (device === null) return null

  const id = await derivedId('user_sessions', userId, device)
  await q(tx).insert(schema.userSessions)
    .values({
      id, userId, deviceId: device, lastLoginAt: null, failedLogins: 0,
      createdAt: nowIso, updatedAt: nowIso,
    })
    .onConflictDoNothing()
  return id
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

  const [user] = await q(db)
    .select({
      id: schema.users.id,
      username: schema.users.username,
      fullName: schema.users.fullName,
      roleId: schema.users.roleId,
      passwordHash: schema.users.passwordHash,
      isActive: schema.users.isActive,
      failedLogins: schema.users.failedLogins,
    })
    .from(schema.users)
    .where(eq(schema.users.username, input.username.trim().toLowerCase()))

  if (!user) {
    await bcrypt.compare(input.password, TIMING_HASH)
    return { ok: false, code: 'INVALID_CREDENTIALS' }
  }

  const matches = await bcrypt.compare(input.password, user.passwordHash)

  // After the password, not before: said first, it tells anyone at the counter
  // which usernames exist, and costs them nothing to learn.
  if (matches && user.isActive === 0) return { ok: false, code: 'ACCOUNT_DISABLED' }

  if (!matches) {
    /* Counted, never acted on. A shop with one till and one owner has no
       help desk to ring at seven in the morning, so an account that locks
       itself is a shop that cannot open — which is a worse outcome than a
       slow guess against a password only reachable by someone standing at
       the counter. The count stays because "this account was guessed at
       forty times on Tuesday" is worth being able to see. */
    await db.transaction(async (tx) => {
      /* Incremented in the database rather than from the number just read: two
         windows on one till would otherwise both write the same value and lose
         a count. Across two tills the same was true and the row could not fix
         it -- last-writer-wins on a counter settles three guesses here and two
         there at three, never five. Since 049 each till counts its own and the
         Staff screen adds them up. */
      /* No session row means this machine could not say which machine it is.
         Then the shared column is the fallback, on purpose: a till that
         cannot identify itself still has somebody typing wrong passwords at
         it, and a badge reading zero while an account is guessed at is worse
         than the occasional conflict. `aSignInIsNotShopNews.test.ts` holds it. */
      const session = await sessionRow(tx, user.id, nowIso)
      if (session === null) {
        await q(tx).update(schema.users)
          .set({ failedLogins: sql`${schema.users.failedLogins} + 1`, updatedAt: nowIso })
          .where(eq(schema.users.id, user.id))
      } else {
        await q(tx).update(schema.userSessions)
          .set({
            failedLogins: sql`${schema.userSessions.failedLogins} + 1`,
            updatedAt: nowIso,
          })
          .where(eq(schema.userSessions.id, session))
      }
      await writeAudit(tx, { actorId: user.id }, {
        entity: 'users', entityId: user.id, action: 'login_failed',
      })
    })

    return { ok: false, code: 'INVALID_CREDENTIALS' }
  }

  await db.transaction(async (tx) => {
    /* Nothing on `users` any more. The row describes the shop -- who this
       person is, what they may do -- and signing in changes none of it. */
    const session = await sessionRow(tx, user.id, nowIso)
    if (session === null) {
      await q(tx).update(schema.users)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: nowIso, updatedAt: nowIso })
        .where(eq(schema.users.id, user.id))
    } else {
      await q(tx).update(schema.userSessions)
        .set({ lastLoginAt: nowIso, failedLogins: 0, updatedAt: nowIso })
        .where(eq(schema.userSessions.id, session))
    }
    await writeAudit(tx, { actorId: user.id }, { entity: 'users', entityId: user.id, action: 'login' })
  })

  const permissions = await loadPermissions(db, user.roleId)

  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      roleId: user.roleId,
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

  /* `is_active`, not the `deleted_at` this used to ask about. Nothing could
     ever set that column, so the check was decorative -- and what it was
     standing in for is real: a cashier disabled while still signed in could
     retype their password and walk into Settings, because the question being
     asked was whether they had been deleted rather than whether they were
     still staff. Migration 032 drops the column and this asks the question it
     was pretending to ask. */
  const [user] = await q(db)
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(and(eq(schema.users.id, input.userId), eq(schema.users.isActive, 1)))

  // No timing dance here, unlike `login`: the caller already knows this user
  // exists — they are signed in as them — so there is nothing to conceal.
  if (!user) return { ok: false, code: 'WRONG_PASSWORD' }

  const right = await bcrypt.compare(input.password, user.passwordHash)

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
  /* Nobody is signed in when the shop's first administrator is made, so that
     one call alone may come without an actor. Every later one is somebody
     adding staff, and needs the right to. */
  const [anyone] = await q(db).select({ id: schema.users.id }).from(schema.users).limit(1)
  if (anyone || input.actorId !== undefined) await requirePermission(db, input.actorId, 'user', 'create')

  const username = input.username.trim().toLowerCase()
  const weak = passwordProblem(input.password)
  if (weak) return { ok: false, code: 'WEAK_PASSWORD', reason: weak }

  const [existing] = await q(db)
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
  if (existing) return { ok: false, code: 'USERNAME_TAKEN' }

  const userId = newId()
  const nowIso = (input.now ?? new Date()).toISOString()
  const hash = await bcrypt.hash(input.password, COST)

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.users).values({
      id: userId,
      username,
      fullName: input.fullName ?? null,
      roleId: input.roleId,
      passwordHash: hash,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
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

  const [user] = await q(db)
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
  if (!user) return { ok: false, code: 'WRONG_PASSWORD' }
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    return { ok: false, code: 'WRONG_PASSWORD' }
  }

  const hash = await bcrypt.hash(input.newPassword, COST)
  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.users)
      .set({ passwordHash: hash, failedLogins: 0, lockedUntil: null, updatedAt: nowIso })
      .where(eq(schema.users.id, input.userId))
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
  await requirePermission(db, input.actorId, 'user', 'write')
  const nowIso = (input.now ?? new Date()).toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.users)
      .set({ isActive: input.isActive ? 1 : 0, updatedAt: nowIso })
      .where(eq(schema.users.id, input.userId))
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

/**
 * Everybody, with what the whole shop knows about them rather than this till.
 *
 * The two aggregates are the point of migration 049 and each answers its
 * question better than the column it replaced. The latest sign-in is a `MAX`,
 * not whichever till wrote last -- a slow clock used to be able to overwrite a
 * later sign-in with an earlier one. The wrong passwords are a `SUM`, so three
 * guesses at the front counter and two at the back read as five; under
 * last-writer-wins they read as three.
 *
 * The `users` columns are the shop's shared baseline from before 049 and are
 * never written again. They are counted once because they replicated and every
 * till already agrees on them.
 */
export async function listStaff(db: SqlDriver): Promise<StaffMember[]> {
  /* raw: two aggregates over a left-joined table, grouped, which the builder
     cannot say without a subquery it would then have to name. */
  const rows = await db.query<{
    id: string; username: string; full_name: string | null; role_id: string
    role_name: string; is_active: number
    last_login_at: string | null; failed_logins: number
  }>(
    `SELECT u.id,
            u.username,
            u.full_name,
            u.role_id,
            r.name AS role_name,
            u.is_active,
            MAX(COALESCE(u.last_login_at, ''), COALESCE(MAX(s.last_login_at), ''))
              AS last_login_at,
            u.failed_logins + COALESCE(SUM(s.failed_logins), 0) AS failed_logins
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN user_sessions s ON s.user_id = u.id
      GROUP BY u.id
      ORDER BY u.is_active DESC, u.username`,
  )

  return rows.map((u) => ({
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    roleId: u.role_id,
    roleName: u.role_name,
    isActive: u.is_active === 1,
    /* `MAX` of two strings, and '' is what a user who has never signed in
       anywhere comes back as. Neither column is ever written empty. */
    lastLoginAt: u.last_login_at === '' ? null : u.last_login_at,
    failedLogins: u.failed_logins,
  }))
}

export async function updateUser(
  db: SqlDriver,
  input: { userId: string; fullName?: string | null; roleId?: string; actorId: string; now?: Date },
): Promise<void> {
  await requirePermission(db, input.actorId, 'user', 'write')
  const [before] = await q(db)
    .select({ fullName: schema.users.fullName, roleId: schema.users.roleId })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
  if (!before) return

  const fullName = input.fullName === undefined ? before.fullName : (input.fullName?.trim() || null)
  const roleId = input.roleId ?? before.roleId
  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.users)
      .set({ fullName, roleId, updatedAt: nowIso })
      .where(eq(schema.users.id, input.userId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'users', entityId: input.userId, action: 'update',
      before: { full_name: before.fullName, role_id: before.roleId },
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
  await requirePermission(db, input.actorId, 'user', 'write')
  const weak = passwordProblem(input.newPassword)
  if (weak) return { ok: false, code: 'WEAK_PASSWORD', reason: weak }

  const hash = await bcrypt.hash(input.newPassword, COST)
  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.users)
      .set({ passwordHash: hash, failedLogins: 0, lockedUntil: null, updatedAt: nowIso })
      .where(eq(schema.users.id, input.userId))
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
 *
 * Since 049 the count is spread across a row per till, so this clears every
 * one of them and not just this machine's — an owner saying "those were mine"
 * means all of them. It is the one place a till writes a row another till
 * owns, and the one place that is right: it is a person's deliberate edit, so
 * a conflict with a count rising somewhere else at that moment is a real
 * disagreement rather than the manufactured kind 049 removed.
 */
export async function unlockUser(
  db: SqlDriver,
  input: { userId: string; actorId: string; now?: Date },
): Promise<void> {
  await requirePermission(db, input.actorId, 'user', 'write')
  const nowIso = (input.now ?? new Date()).toISOString()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.users)
      .set({ failedLogins: 0, lockedUntil: null, updatedAt: nowIso })
      .where(eq(schema.users.id, input.userId))
    await q(tx).update(schema.userSessions)
      .set({ failedLogins: 0, updatedAt: nowIso })
      .where(eq(schema.userSessions.userId, input.userId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'users', entityId: input.userId, action: 'update', after: { unlocked: 1 },
    })
  })
}
