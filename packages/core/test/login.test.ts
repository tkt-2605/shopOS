import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { login, createUser, listStaff, unlockUser, setUserActive } from '../src/services/auth.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Signing in at the counter.
 *
 * A wrong password is counted and never acted on. A shop with one till and one
 * owner has nobody to ring at seven in the morning, so an account that locks
 * itself is a shop that cannot open — a worse outcome than a slow guess against
 * a password only reachable by somebody already standing at the counter.
 */

let fx: Fixture
let userId: string

const PASSWORD = 'counter-9'

beforeEach(async () => {
  fx = await freshDb()
  const created = await createUser(fx.db, {
    username: 'ramesh', password: PASSWORD, roleId: fx.seed.roleIds['Admin']!,
  })
  if (!created.ok) throw new Error('could not create the test user')
  userId = created.userId
})

afterEach(async () => { await fx.db.close() })

const signIn = (password: string) => login(fx.db, { username: 'ramesh', password })

async function failedCount(): Promise<number> {
  const row = await fx.db.get<{ failed_logins: number }>(
    `SELECT failed_logins FROM users WHERE id = ?`, [userId],
  )
  return row!.failed_logins
}

describe('signing in', () => {
  it('lets the right password through', async () => {
    const result = await signIn(PASSWORD)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.user.username).toBe('ramesh')
  })

  it('turns the wrong one away', async () => {
    expect(await signIn('guess')).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' })
  })

  it('answers the same way for a username that does not exist', async () => {
    // Otherwise the failure tells an outsider which usernames are real.
    expect(await login(fx.db, { username: 'nobody', password: 'guess' }))
      .toEqual({ ok: false, code: 'INVALID_CREDENTIALS' })
  })

  it('says plainly when the account has been turned off', async () => {
    await setUserActive(fx.db, { userId, isActive: false, actorId: fx.adminId })
    expect(await signIn(PASSWORD)).toEqual({ ok: false, code: 'ACCOUNT_DISABLED' })
  })
})

describe('getting the password wrong', () => {
  /* Twenty-one bcrypt comparisons at cost 10, which is a little over five
     seconds of deliberate work on an idle machine and more on a busy one.
     The default budget is five, so this failed against a loaded laptop and
     passed alone -- a red run that says nothing about the code, which is the
     kind that teaches people to re-run rather than read. The cost factor is
     the point of the test, so the budget is what moves. */
  it('never locks the account, however many times it happens', async () => {
    // The shop has to be able to open in the morning.
    for (let i = 0; i < 20; i++) await signIn('guess')

    expect((await signIn(PASSWORD)).ok).toBe(true)
  }, 30_000)

  it('counts the attempts, so a run of them can be seen afterwards', async () => {
    await signIn('guess')
    await signIn('guess')
    await signIn('guess')

    expect(await failedCount()).toBe(3)
  })

  it('starts the count again once somebody gets in', async () => {
    await signIn('guess')
    await signIn('guess')
    await signIn(PASSWORD)

    expect(await failedCount()).toBe(0)
  })

  it('records each one against the account', async () => {
    await signIn('guess')
    await signIn('guess')

    const rows = await fx.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'users' AND entity_id = ? AND action = 'login_failed'`,
      [userId],
    )
    expect(rows).toHaveLength(2)
  })
})

describe('what the staff screen shows', () => {
  it('reports the run of wrong passwords rather than a lock state', async () => {
    await signIn('guess')
    await signIn('guess')

    const row = (await listStaff(fx.db)).find((m) => m.id === userId)!
    expect(row.failedLogins).toBe(2)
  })

  it('lets an owner clear a count they know about', async () => {
    await signIn('guess')
    await unlockUser(fx.db, { userId, actorId: fx.adminId })

    expect((await listStaff(fx.db)).find((m) => m.id === userId)!.failedLogins).toBe(0)
  })

  it('clears a lock left behind by an older build', async () => {
    // Databases from before the lockout was removed still carry the column.
    await fx.db.execute(
      `UPDATE users SET locked_until = ? WHERE id = ?`, ['2099-01-01T00:00:00.000Z', userId],
    )

    // It no longer stops anyone signing in, and clearing it tidies it away.
    expect((await signIn(PASSWORD)).ok).toBe(true)
    await unlockUser(fx.db, { userId, actorId: fx.adminId })

    const row = await fx.db.get<{ locked_until: string | null }>(
      `SELECT locked_until FROM users WHERE id = ?`, [userId],
    )
    expect(row!.locked_until).toBeNull()
  })
})
