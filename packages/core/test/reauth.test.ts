import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { reauthenticate, createUser, login } from '../src/services/auth.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Proving again that the person at the keyboard is who signed in.
 *
 * The theme here is that this door checks the password and nothing else. It is
 * only ever reached by somebody already signed in at the counter, so counting
 * their attempts would guard against nothing the locked front door does not
 * already cover — while locking an owner out of their own Settings screen
 * mid-job is exactly how a gate ends up switched off.
 *
 * What it does keep is the record, which is the part that answers "who changed
 * the receipt on Tuesday".
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

async function failedLogins(): Promise<number> {
  const row = await fx.db.get<{ failed_logins: number }>(
    `SELECT failed_logins FROM users WHERE id = ?`, [userId],
  )
  return row!.failed_logins
}

async function auditRows() {
  return fx.db.query<{ action: string; actor_id: string; diff: string | null }>(
    `SELECT action, actor_id, diff FROM audit_log WHERE entity = 'users' AND entity_id = ? ORDER BY rowid`,
    [userId],
  )
}

describe('unlocking a settings screen', () => {
  it('accepts the signed-in person’s own password', async () => {
    expect(await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' }))
      .toEqual({ ok: true })
  })

  it('refuses a wrong one', async () => {
    expect(await reauthenticate(fx.db, { userId, password: 'guess', scope: 'settings' }))
      .toEqual({ ok: false, code: 'WRONG_PASSWORD' })
  })

  it('goes on accepting the right password however many times it is asked', async () => {
    for (let i = 0; i < 12; i++) {
      expect(await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' }))
        .toEqual({ ok: true })
    }
  })
})

describe('a wrong password at this door', () => {
  it('never locks the account, however many times it is wrong', async () => {
    for (let i = 0; i < 12; i++) {
      await reauthenticate(fx.db, { userId, password: 'guess', scope: 'settings' })
    }

    expect(await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' }))
      .toEqual({ ok: true })
  })

  it('leaves the front door exactly as it was', async () => {
    // Signing in has its own counter, and this screen does not touch it in
    // either direction.
    for (let i = 0; i < 12; i++) {
      await reauthenticate(fx.db, { userId, password: 'guess', scope: 'settings' })
    }

    expect(await failedLogins()).toBe(0)
    expect((await login(fx.db, { username: 'ramesh', password: PASSWORD })).ok).toBe(true)
  })

  it('does not wipe what the sign-in screen recorded', async () => {
    // Otherwise unlocking Settings would clear the evidence of somebody
    // guessing at the front door.
    await login(fx.db, { username: 'ramesh', password: 'wrong' })
    await login(fx.db, { username: 'ramesh', password: 'wrong' })
    const before = await failedLogins()
    expect(before).toBe(2)

    await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' })

    expect(await failedLogins()).toBe(before)
  })
})

describe('what the history says afterwards', () => {
  it('records a failed unlock against the person who tried, and which screen', async () => {
    await reauthenticate(fx.db, { userId, password: 'guess', scope: 'roles' })

    const rows = await auditRows()
    const failed = rows.filter((r) => r.action === 'login_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.actor_id).toBe(userId)
    expect(failed[0]!.diff).toContain('roles')
  })

  it('records a successful unlock, so opening settings is answerable', async () => {
    await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' })

    const opened = (await auditRows()).filter((r) => r.action === 'login')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.diff).toContain('settings')
  })

  it('records every attempt, not only the one that worked', async () => {
    await reauthenticate(fx.db, { userId, password: 'guess', scope: 'settings' })
    await reauthenticate(fx.db, { userId, password: 'guess', scope: 'settings' })
    await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' })

    const rows = await auditRows()
    expect(rows.filter((r) => r.action === 'login_failed')).toHaveLength(2)
    expect(rows.filter((r) => r.action === 'login')).toHaveLength(1)
  })

  it('marks the row as a re-check rather than a sign-in', async () => {
    // The action has to be one `audit_log`'s CHECK already allows, so the
    // distinction lives in the diff instead.
    await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' })

    const opened = (await auditRows()).filter((r) => r.action === 'login')
    expect(opened[0]!.diff).toContain('reauth')
  })
})

describe('a user who is no longer there', () => {
  it('does not pretend a deleted user’s password was simply wrong for ever', async () => {
    await fx.db.execute(
      `UPDATE users SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), userId],
    )

    expect(await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' }))
      .toEqual({ ok: false, code: 'WRONG_PASSWORD' })
  })
})
