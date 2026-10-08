import bcrypt from 'bcryptjs'
import { and, eq } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { writeAudit } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'
import { getSetting, setSetting } from './settings.js'

/*
 * The shop's way back in when the owner has forgotten the password.
 *
 * `resetPassword` needs somebody signed in who may reset passwords, and a shop
 * with one owner has nobody else. Without this, the only way back into a till
 * whose owner forgot is a developer opening the database by hand -- with the
 * shop shut while they do.
 *
 * The answer works offline, like everything at the counter: a code made when
 * the shop is set up, shown once, written on paper and kept away from the till.
 * Only its hash is kept. It is a setting, so it travels with the shop and works
 * at any counter -- a code that worked on one machine only would be lost with
 * that machine.
 *
 * A code is used once. Using it makes the next one, because a code typed in
 * front of the counter may have been seen.
 */

const HASH = 'recovery_code_hash'
const MADE_AT = 'recovery_code_made_at'

/** bcrypt's work for a code with a hundred bits in it is a formality; it matches the passwords. */
const COST = 10

/** Crockford's base32: no I, L, O or U, so nothing on paper reads as two different letters. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Twenty characters of thirty-two: a hundred bits, which nobody guesses at a keyboard. */
const LENGTH = 20

function freshCode(): string {
  const bytes = new Uint8Array(LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  /* 256 is a multiple of 32, so the low five bits of a byte are uniform. */
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('')
}

/** `K7QM2-XPA4B-…`, the way it is shown and printed. Groups of five, read aloud easily. */
export function formatRecoveryCode(code: string): string {
  return normaliseRecoveryCode(code).match(/.{1,5}/g)?.join('-') ?? ''
}

/**
 * What a person typed, as the code it means. Spaces, dashes and case are
 * forgiven, and the letters Crockford leaves out are read as the digits they
 * look like -- a code copied by hand comes back with an O where the 0 was.
 */
export function normaliseRecoveryCode(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '')
}

/** Writes a new code over whatever was there and returns it, formatted. The caller holds the transaction. */
async function writeCode(tx: SqlDriver, actorId: string | null, nowIso: string): Promise<string> {
  const code = freshCode()
  await setSetting(tx, HASH, await bcrypt.hash(code, COST), nowIso)
  await setSetting(tx, MADE_AT, nowIso, nowIso)
  // The code itself never reaches the audit trail, nor its hash.
  await writeAudit(tx, { actorId }, {
    entity: 'settings', entityId: HASH, action: 'update', after: { recovery_code_made: 1 },
  })
  return formatRecoveryCode(code)
}

export interface RecoveryCodeState {
  /** When the code in force was made. Null when this shop has never had one. */
  madeAt: string | null
}

export async function recoveryCodeState(db: SqlDriver): Promise<RecoveryCodeState> {
  const hash = await getSetting(db, HASH)
  return { madeAt: hash === null ? null : await getSetting(db, MADE_AT) }
}

/**
 * The first code, made with the shop. Nobody is signed in yet, which is why
 * this one alone takes no actor -- and why it refuses a shop that has a code
 * already, so it cannot be used to replace one without the right to.
 */
export async function firstRecoveryCode(db: SqlDriver, now?: Date): Promise<string> {
  const nowIso = (now ?? new Date()).toISOString()
  return db.transaction(async (tx) => {
    if (await getSetting(tx, HASH) !== null) throw new Error('this shop already has a recovery code')
    return writeCode(tx, null, nowIso)
  })
}

/**
 * A new code, from the Staff screen. The old one stops working at once -- on
 * every till, as soon as the setting reaches it.
 *
 * Needs the same right as resetting somebody's password, because it is the
 * same power held on paper.
 */
export async function makeRecoveryCode(
  db: SqlDriver,
  input: { actorId: string; now?: Date },
): Promise<string> {
  await requirePermission(db, input.actorId, 'user', 'write')
  const nowIso = (input.now ?? new Date()).toISOString()
  return db.transaction((tx) => writeCode(tx, input.actorId, nowIso))
}

export type RecoverResult =
  | { ok: true; userId: string; newCode: string }
  | { ok: false; code: 'NO_CODE' }
  | { ok: false; code: 'WRONG_CODE' }
  | { ok: false; code: 'NO_SUCH_USER' }
  | { ok: false; code: 'WEAK_PASSWORD'; reason: string }

/**
 * Sets a new password for `username` on the strength of the recovery code, and
 * replaces the code.
 *
 * The code is checked before the name, so a wrong code says nothing about who
 * has an account. Every wrong code is written down: nothing locks, for the
 * same reason sign-in does not, but an owner can see that it was tried.
 */
export async function recoverWithCode(
  db: SqlDriver,
  input: { code: string; username: string; newPassword: string; now?: Date },
): Promise<RecoverResult> {
  const nowIso = (input.now ?? new Date()).toISOString()

  const hash = await getSetting(db, HASH)
  if (hash === null) return { ok: false, code: 'NO_CODE' }

  if (!await bcrypt.compare(normaliseRecoveryCode(input.code), hash)) {
    await db.transaction(async (tx) => {
      await writeAudit(tx, { actorId: null }, {
        entity: 'settings', entityId: HASH, action: 'login_failed', after: { recovery_code_wrong: 1 },
      })
    })
    return { ok: false, code: 'WRONG_CODE' }
  }

  const [user] = await q(db)
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      eq(schema.users.username, input.username.trim().toLowerCase()),
      eq(schema.users.isActive, 1),
    ))
  if (!user) return { ok: false, code: 'NO_SUCH_USER' }

  const weak = passwordProblem(input.newPassword)
  if (weak) return { ok: false, code: 'WEAK_PASSWORD', reason: weak }

  const passwordHash = await bcrypt.hash(input.newPassword, COST)

  return db.transaction(async (tx) => {
    /* The code was checked outside this transaction, because bcrypt is slow.
       If it was replaced in between -- by the Staff screen, or by another
       window doing exactly this -- the one typed is no longer the shop's. */
    if (await getSetting(tx, HASH) !== hash) return { ok: false, code: 'WRONG_CODE' } as const

    await q(tx).update(schema.users)
      .set({ passwordHash, failedLogins: 0, lockedUntil: null, updatedAt: nowIso })
      .where(eq(schema.users.id, user.id))
    await writeAudit(tx, { actorId: user.id }, {
      entity: 'users', entityId: user.id, action: 'update', after: { password_reset_by_recovery_code: 1 },
    })
    const newCode = await writeCode(tx, user.id, nowIso)
    return { ok: true, userId: user.id, newCode } as const
  })
}

/* The same rule `auth.ts` holds a password to. Repeated rather than exported
   from there so this file can come out without touching sign-in. */
function passwordProblem(password: string): string | null {
  if (password.length < 6) return 'Use at least 6 characters'
  if (/^\d+$/.test(password)) return 'Use more than just digits'
  return null
}
