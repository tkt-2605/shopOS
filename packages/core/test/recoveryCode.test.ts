import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { login, createUser } from '../src/services/auth.js'
import {
  firstRecoveryCode, makeRecoveryCode, recoverWithCode, recoveryCodeState,
  formatRecoveryCode, normaliseRecoveryCode,
} from '../src/services/recovery.js'
import { firstRun } from '../src/services/seed.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { PermissionError } from '../src/integrity/permissions.js'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * The owner has forgotten the password, and there is nobody else.
 *
 * `resetPassword` needs somebody signed in who may reset passwords. In a shop
 * with one owner that is the person who forgot, so before the recovery code
 * the only way back in was a developer and the database.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const signIn = (username: string, password: string) => login(fx.db, { username, password })

describe('a shop set up from nothing', () => {
  it('is given a recovery code with its first administrator', async () => {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS)
    const { recoveryCode } = await firstRun(db, { shopName: 'New Shop', adminPassword: 'owner-pass' })

    expect(recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/)
    expect((await recoveryCodeState(db)).madeAt).not.toBeNull()

    const back = await recoverWithCode(db, { code: recoveryCode, username: 'admin', newPassword: 'fresh-start' })
    expect(back.ok).toBe(true)
    expect((await login(db, { username: 'admin', password: 'fresh-start' })).ok).toBe(true)
    await db.close()
  })
})

describe('the recovery code', () => {
  it('lets the owner in with a new password, and the old one stops working', async () => {
    await createUser(fx.db, { username: 'owner', password: 'old-pass', roleId: fx.seed.roleIds['Admin']!, actorId: fx.adminId })
    const code = await firstRecoveryCode(fx.db)

    const result = await recoverWithCode(fx.db, { code, username: 'owner', newPassword: 'new-pass' })

    expect(result.ok).toBe(true)
    expect((await signIn('owner', 'new-pass')).ok).toBe(true)
    expect((await signIn('owner', 'old-pass')).ok).toBe(false)
  })

  it('works once: using it makes the next one, and the used one is refused', async () => {
    const code = await firstRecoveryCode(fx.db)
    const first = await recoverWithCode(fx.db, { code, username: 'admin', newPassword: 'pass-one' })
    if (!first.ok) throw new Error(first.code)

    expect(first.newCode).not.toBe(code)
    expect(await recoverWithCode(fx.db, { code, username: 'admin', newPassword: 'pass-two' }))
      .toEqual({ ok: false, code: 'WRONG_CODE' })
    expect((await recoverWithCode(fx.db, { code: first.newCode, username: 'admin', newPassword: 'pass-two' })).ok)
      .toBe(true)
  })

  it('forgives how it was copied: case, spaces, dashes, and O for 0', async () => {
    const code = await firstRecoveryCode(fx.db)
    const sloppy = normaliseRecoveryCode(code).toLowerCase().replace(/0/g, 'o').match(/.{1,4}/g)!.join(' ')

    expect((await recoverWithCode(fx.db, { code: sloppy, username: 'admin', newPassword: 'pass-one' })).ok).toBe(true)
  })

  it('refuses a wrong code, changes nothing, and writes the attempt down', async () => {
    await createUser(fx.db, { username: 'owner', password: 'old-pass', roleId: fx.seed.roleIds['Admin']!, actorId: fx.adminId })
    await firstRecoveryCode(fx.db)

    const result = await recoverWithCode(fx.db, {
      code: 'AAAAA-AAAAA-AAAAA-AAAAA', username: 'owner', newPassword: 'new-pass',
    })

    expect(result).toEqual({ ok: false, code: 'WRONG_CODE' })
    expect((await signIn('owner', 'old-pass')).ok).toBe(true)
    const tried = await fx.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'settings' AND action = 'login_failed'`,
    )
    expect(tried[0]!.n).toBe(1)
  })

  it('says nothing about who has an account until the code is right', async () => {
    await firstRecoveryCode(fx.db)
    expect(await recoverWithCode(fx.db, { code: 'AAAAA', username: 'nobody', newPassword: 'new-pass' }))
      .toEqual({ ok: false, code: 'WRONG_CODE' })
  })

  it('with the right code, still needs an account that exists and a real password', async () => {
    const code = await firstRecoveryCode(fx.db)
    expect(await recoverWithCode(fx.db, { code, username: 'nobody', newPassword: 'new-pass' }))
      .toEqual({ ok: false, code: 'NO_SUCH_USER' })
    expect((await recoverWithCode(fx.db, { code, username: 'admin', newPassword: '123456' })).ok).toBe(false)
    // Neither of those spent the code.
    expect((await recoverWithCode(fx.db, { code, username: 'admin', newPassword: 'good-pass' })).ok).toBe(true)
  })

  it('says so plainly when the shop never had one', async () => {
    expect(await recoverWithCode(fx.db, { code: 'AAAAA', username: 'admin', newPassword: 'new-pass' }))
      .toEqual({ ok: false, code: 'NO_CODE' })
    expect(await recoveryCodeState(fx.db)).toEqual({ madeAt: null })
  })

  it('is kept as a hash, never as itself', async () => {
    const code = await firstRecoveryCode(fx.db)
    const rows = await fx.db.query<{ value: string }>(`SELECT value FROM settings`)
    const audit = await fx.db.query<{ diff: string | null }>(`SELECT diff FROM audit_log`)
    const raw = normaliseRecoveryCode(code)
    for (const r of rows) expect(r.value.includes(raw)).toBe(false)
    for (const a of audit) expect((a.diff ?? '').includes(raw)).toBe(false)
  })
})

describe('making a new code', () => {
  it('needs the right to reset passwords, and the old code stops working', async () => {
    const old = await firstRecoveryCode(fx.db)
    const fresh = await makeRecoveryCode(fx.db, { actorId: fx.adminId })

    expect(await recoverWithCode(fx.db, { code: old, username: 'admin', newPassword: 'new-pass' }))
      .toEqual({ ok: false, code: 'WRONG_CODE' })
    expect((await recoverWithCode(fx.db, { code: fresh, username: 'admin', newPassword: 'new-pass' })).ok).toBe(true)
  })

  it('is refused to a cashier', async () => {
    const made = await createUser(fx.db, {
      username: 'cashier', password: 'till-pass', roleId: fx.seed.roleIds['Cashier']!, actorId: fx.adminId,
    })
    if (!made.ok) throw new Error(made.code)
    await expect(makeRecoveryCode(fx.db, { actorId: made.userId })).rejects.toBeInstanceOf(PermissionError)
  })

  it('cannot be done the first-run way once a shop has a code', async () => {
    await firstRecoveryCode(fx.db)
    await expect(firstRecoveryCode(fx.db)).rejects.toThrow(/already has a recovery code/)
  })
})

describe('the shape of a code', () => {
  it('is four groups of five, from letters that cannot be misread', () => {
    expect(formatRecoveryCode('abcdefghjkmnpqrstvwx')).toBe('ABCDE-FGHJK-MNPQR-STVWX')
    expect(normaliseRecoveryCode('o1l-I')).toBe('0111')
  })
})
