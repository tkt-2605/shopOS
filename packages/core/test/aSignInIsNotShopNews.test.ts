import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { login, createUser, listStaff, unlockUser } from '../src/services/auth.js'
import { feedHead, changesSince } from '../src/services/changefeed.js'
import { setDeviceId } from '../src/device.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * Signing in is not news for the other counter.
 *
 * `login` used to write `last_login_at`, `failed_logins` and `updated_at` onto
 * the `users` row, and `users` replicates. Two tills switched on within one sync
 * round of each other — 45 seconds, which is what opening time looks like — each
 * raised that row's revision before either had told the other, so the merge
 * filed a conflict saying an edit was being dropped. Every morning, over a login
 * timestamp. Four of the nine conflicts on the three bench tills were this, and
 * the cost is not the row: it is that `sync_conflicts` is where a shopkeeper
 * looks on the day a real edit goes missing, and a table full of noise is a
 * table nobody reads.
 *
 * The second half matters more. `failed_logins` is a counter, and the merge
 * settles it by last-writer-wins — so three wrong guesses at the front counter
 * and two at the back read as three, never five. The badge on the Staff screen
 * could under-report the one thing it is there for.
 *
 * Migration 049 gives each till its own row, keyed by the user and the machine
 * together, so nothing is merged and the screen adds them up instead.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

const PASSWORD = 'counter-9'

let fx: Fixture
let userId: string

beforeEach(async () => {
  fx = await freshDb()
  setDeviceId(TILL_A)
  const created = await createUser(fx.db, {
    username: 'ramesh', password: PASSWORD, roleId: fx.seed.roleIds['Admin']!, actorId: fx.adminId,
  })
  if (!created.ok) throw new Error('could not create the test user')
  userId = created.userId
})

afterEach(async () => {
  setDeviceId(null)
  await fx.db.close()
})

const signIn = (password = PASSWORD) => login(fx.db, { username: 'ramesh', password })

/** What this till would send the other one, by table. */
async function feedTables(since = 0): Promise<string[]> {
  const entries = await changesSince(fx.db, since, 500)
  return entries.map((e) => e.table)
}

async function usersRev(): Promise<number> {
  const row = await fx.db.get<{ rev: number }>(`SELECT rev FROM users WHERE id = ?`, [userId])
  return row!.rev
}

async function only(): Promise<{ lastLoginAt: string | null; failedLogins: number }> {
  const staff = await listStaff(fx.db)
  const row = staff.find((s) => s.username === 'ramesh')!
  return { lastLoginAt: row.lastLoginAt, failedLogins: row.failedLogins }
}

describe('what a sign-in tells the rest of the shop', () => {
  it('does not raise the revision of the row that describes the person', async () => {
    const before = await usersRev()
    expect((await signIn()).ok).toBe(true)

    expect(
      await usersRev(),
      'a sign-in changes nothing about who this person is or what they may do',
    ).toBe(before)
  })

  it('does not queue the users row for the other till', async () => {
    const from = await feedHead(fx.db)
    expect((await signIn()).ok).toBe(true)

    expect(await feedTables(from)).not.toContain('users')
  })

  it('still travels, because the shop wants it — as a row this till owns', async () => {
    /* Not the same as "does not replicate". The Staff screen asks a question
       about the shop, so the rows cross; what changed is that each till writes
       its own and no two tills ever touch the same one. */
    const from = await feedHead(fx.db)
    expect((await signIn()).ok).toBe(true)

    expect(await feedTables(from)).toContain('user_sessions')
  })

  it('writes one row per till, so two counters never contend', async () => {
    expect((await signIn()).ok).toBe(true)
    setDeviceId(TILL_B)
    expect((await signIn()).ok).toBe(true)

    const rows = await fx.db.query<{ id: string; device_id: string }>(
      `SELECT id, device_id FROM user_sessions WHERE user_id = ? ORDER BY device_id`, [userId],
    )
    expect(rows.map((r) => r.device_id)).toEqual([TILL_A, TILL_B])
    expect(rows[0]!.id, 'two tills, two rows, two ids').not.toBe(rows[1]!.id)
  })

  it('gives the same till the same row every time, rather than one per sign-in', async () => {
    for (let i = 0; i < 3; i += 1) expect((await signIn()).ok).toBe(true)

    const [count] = await fx.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?`, [userId],
    )
    expect(count!.n).toBe(1)
  })
})

describe('what the Staff screen adds up', () => {
  it('totals the wrong passwords across the counters rather than taking one', async () => {
    /* The reason this is not a merged column. Three here and two there is five
       attempts at one account, and last-writer-wins answers three. */
    for (let i = 0; i < 3; i += 1) await signIn('wrong')
    setDeviceId(TILL_B)
    for (let i = 0; i < 2; i += 1) await signIn('wrong')

    expect((await only()).failedLogins).toBe(5)
  })

  it('clears the count everywhere when the owner says those were theirs', async () => {
    await signIn('wrong')
    setDeviceId(TILL_B)
    await signIn('wrong')
    expect((await only()).failedLogins).toBe(2)

    await unlockUser(fx.db, { userId, actorId: userId })

    expect(
      (await only()).failedLogins,
      'all of them, not this machine\'s share — the owner meant all of them',
    ).toBe(0)
  })

  it('reports the latest sign-in anywhere, not whichever till wrote last', async () => {
    /* The other half of why a column could not do this. A till running slow
       writes an older timestamp later, and under last-writer-wins the older one
       wins — so the screen could move backwards. */
    const later = new Date('2026-09-19T10:00:00.000Z')
    const earlier = new Date('2026-09-19T08:00:00.000Z')

    await login(fx.db, { username: 'ramesh', password: PASSWORD, now: later })
    setDeviceId(TILL_B)
    await login(fx.db, { username: 'ramesh', password: PASSWORD, now: earlier })

    expect((await only()).lastLoginAt).toBe(later.toISOString())
  })

  it('keeps what the shop knew before 049, which no backfill could have moved', async () => {
    /* A row here needs this till's device id, and the database has none —
       `device.json` holds it and the backup deliberately does not carry it. So
       the old columns stay as the shop's shared baseline and are read beside the
       session rows. Zeroing them would have shown "never signed in" against
       every name on the morning of the upgrade. */
    await fx.db.execute(
      `UPDATE users SET last_login_at = ?, failed_logins = 4 WHERE id = ?`,
      ['2026-09-01T09:00:00.000Z', userId],
    )

    const before = await only()
    expect(before.lastLoginAt).toBe('2026-09-01T09:00:00.000Z')
    expect(before.failedLogins).toBe(4)

    await signIn('wrong')
    expect((await only()).failedLogins, 'the baseline plus this till\'s one').toBe(5)
  })

  it('says nothing rather than an empty string for somebody who never signed in', async () => {
    expect((await only()).lastLoginAt).toBeNull()
  })
})

describe('a till that could not say which machine it is', () => {
  it('counts on the shared row rather than not counting at all', async () => {
    /* `establishDevice` runs before the first sign-in and reports its own
       failure, but it can fail — and a till that cannot identify itself still
       has somebody typing wrong passwords at it. The shared count and the
       occasional conflict are the better trade against a badge that reads zero
       while an account is being guessed at. */
    setDeviceId(null)
    for (let i = 0; i < 2; i += 1) await signIn('wrong')

    const [rows] = await fx.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_sessions`,
    )
    expect(rows!.n, 'nothing to key a row by').toBe(0)
    expect((await only()).failedLogins).toBe(2)
  })
})
