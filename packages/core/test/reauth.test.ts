import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { reauthenticate, createUser, login } from '../src/services/auth.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Proving again that the person at the keyboard is who signed in.
 *
 * The theme here is that the Settings door counts a wrong password exactly the
 * way the front door does. A gate that forgave guesses would be a softer way in
 * than the sign-in screen, which would make it the way in.
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

describe('unlocking a settings screen', () => {
  it('accepts the signed-in person’s own password', async () => {
    expect(await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' }))
      .toEqual({ ok: true })
  })

  it('refuses a wrong password and says how many tries are left', async () => {
    expect(await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'settings' }))
      .toEqual({ ok: false, code: 'WRONG_PASSWORD', attemptsLeft: 4 })
  })

  it('locks the account after five wrong tries, the way signing in does', async () => {
    for (let i = 0; i < 4; i++) {
      await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'settings' })
    }
    const fifth = await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'settings' })

    expect(fifth.ok).toBe(false)
    expect(fifth).toMatchObject({ code: 'ACCOUNT_LOCKED' })
  })

  it('shuts the front door too when the settings door is what was guessed at', async () => {
    for (let i = 0; i < 5; i++) {
      await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'settings' })
    }

    // The whole point of sharing the counter: guessing here is guessing, and
    // walking back to the sign-in screen must not reset the count.
    const signIn = await login(fx.db, { username: 'ramesh', password: PASSWORD })
    expect(signIn).toMatchObject({ ok: false, code: 'ACCOUNT_LOCKED' })
  })

  it('forgets the failed tries once the right password is given', async () => {
    await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'settings' })
    await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' })

    expect(await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'settings' }))
      .toEqual({ ok: false, code: 'WRONG_PASSWORD', attemptsLeft: 4 })
  })

  it('refuses while the account is locked, even with the right password', async () => {
    for (let i = 0; i < 5; i++) {
      await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'settings' })
    }

    expect(await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' }))
      .toMatchObject({ ok: false, code: 'ACCOUNT_LOCKED' })
  })

  it('records a failed unlock against the person who tried, and which screen', async () => {
    await reauthenticate(fx.db, { userId, password: 'wrong', scope: 'roles' })

    const row = await fx.db.get<{ actor_id: string; action: string; diff: string }>(
      `SELECT actor_id, action, diff FROM audit_log WHERE entity_id = ? ORDER BY at DESC`,
      [userId],
    )

    expect(row?.actor_id).toBe(userId)
    expect(row?.action).toBe('login_failed')
    expect(JSON.parse(row!.diff)['screen']).toEqual({ from: null, to: 'roles' })
  })

  it('records a successful unlock, so opening settings is answerable', async () => {
    await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' })

    const row = await fx.db.get<{ action: string; diff: string }>(
      `SELECT action, diff FROM audit_log WHERE entity_id = ? ORDER BY at DESC`,
      [userId],
    )

    expect(row?.action).toBe('login')
    expect(JSON.parse(row!.diff)['reauth']).toEqual({ from: null, to: 1 })
  })

  it('does not pretend a deleted user’s password was simply wrong for ever', async () => {
    await fx.db.execute(`UPDATE users SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), userId])

    expect(await reauthenticate(fx.db, { userId, password: PASSWORD, scope: 'settings' }))
      .toEqual({ ok: false, code: 'WRONG_PASSWORD', attemptsLeft: 0 })
  })
})
