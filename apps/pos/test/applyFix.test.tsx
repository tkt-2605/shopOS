import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { webcrypto, randomBytes } from 'node:crypto'
import { migrate, bootstrap, createUser, getSetting, type SqlDriver } from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { toBase64Url } from '../../../packages/core/src/domain/licence'
import * as repair from '../../../packages/core/src/services/repair'

/**
 * Applying a fix from support at the till: what it will do is said first, and
 * only the owner's password, after a backup, changes anything.
 *
 * The build's repair keys are its own (`config/repairs.ts`); the test signs
 * with a key of its own and hands it to the same `checkPack` and `applyPack`
 * the card calls, which is the only thing that differs from a shop's build.
 */

const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair
const KEYS = [{ kid: 'repair-test', publicKey: toBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))) }]
const keys = { useTest: true }

vi.mock('@shopos/core', async (load) => {
  const real = await load<typeof import('@shopos/core')>()
  return {
    ...real,
    checkPack: (db: SqlDriver, raw: string) => repair.checkPack(db, raw, { keys: keys.useTest ? KEYS : [] }),
    applyPack: (db: SqlDriver, input: { raw: string; actorId: string }) =>
      repair.applyPack(db, { ...input, keys: keys.useTest ? KEYS : [] }),
  }
})

const core: { db: SqlDriver | null; reloadRegister: () => Promise<void> } = { db: null, reloadRegister: async () => {} }
const user = { id: '', username: 'owner', fullName: null, roleId: '', roleName: 'Admin', permissions: {} }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core, useUser: () => user }))
const backups = { taken: 0, fails: false }
vi.mock('../src/core/backup', () => ({
  takeBackupNow: async () => { if (backups.fails) throw new Error('disk full'); backups.taken += 1; return { attachments: 0 } },
}))
const { ApplyFixCard } = await import('../src/pages/settings/ApplyFixCard')

let registerId = ''
let shopId = ''

async function sign(repairs: unknown[]): Promise<string> {
  const payload = {
    format: 1, id: randomBytes(16).toString('hex'), kid: 'repair-test', shopId,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ticket: '142: counter held by a dead till', repairs,
  }
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(encoded)))
  return `${encoded}.${toBase64Url(sig)}`
}

const claimedBy = async () =>
  (await core.db!.get<{ claimed_by: string | null }>('SELECT claimed_by FROM registers WHERE id = ?', [registerId]))?.claimed_by

beforeEach(async () => {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Test Shop' })
  const made = await createUser(db, { username: 'owner', password: 'right-pass-9', roleId: seed.roleIds['Admin']! })
  if (!made.ok) throw new Error('no user')
  user.id = made.userId
  registerId = seed.registerId
  shopId = (await getSetting(db, 'shop_id'))!
  await db.execute(`UPDATE registers SET claimed_by = 'dead-till-0000' WHERE id = ?`, [registerId])
  core.db = db
  keys.useTest = true
  Object.assign(backups, { taken: 0, fails: false })
})
afterEach(async () => {
  cleanup()
  await core.db?.close()
})

async function paste(raw: string) {
  render(<ApplyFixCard />)
  fireEvent.change(screen.getByLabelText('The fix support sent'), { target: { value: raw } })
  fireEvent.click(screen.getByText('Check it'))
}

describe('applying a fix from support', () => {
  it('says what it will do, and the case it is for, before anything changes', async () => {
    await paste(await sign([{ kind: 'free_counter', registerId }]))
    expect(await screen.findByText(/Let go of counter/)).toBeTruthy()
    expect(document.body.textContent).toContain('142: counter held by a dead till')
    expect(await claimedBy()).toBe('dead-till-0000')
  })

  it('changes nothing on the wrong password', async () => {
    await paste(await sign([{ kind: 'free_counter', registerId }]))
    fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByText('Apply it'))
    expect(await screen.findByText('That is not your password.')).toBeTruthy()
    expect(backups.taken).toBe(0)
    expect(await claimedBy()).toBe('dead-till-0000')
  })

  it('takes a backup, then applies it, and says what was done', async () => {
    await paste(await sign([{ kind: 'free_counter', registerId }]))
    fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'right-pass-9' } })
    fireEvent.click(screen.getByText('Apply it'))
    expect(await screen.findByText('Done:')).toBeTruthy()
    expect(backups.taken).toBe(1)
    expect(await claimedBy()).toBeNull()
  })

  it('changes nothing when the backup before it cannot be taken', async () => {
    backups.fails = true
    await paste(await sign([{ kind: 'free_counter', registerId }]))
    fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'right-pass-9' } })
    fireEvent.click(screen.getByText('Apply it'))
    expect(await screen.findByText(/Nothing was changed: the backup before it could not be taken \(disk full\)/)).toBeTruthy()
    expect(await claimedBy()).toBe('dead-till-0000')
  })

  it('refuses text that is not a fix, in words', async () => {
    await paste('hello, please fix my till')
    expect(await screen.findByText(/That is not a fix from support/)).toBeTruthy()
  })

  it('says so plainly in a build with no repair key, rather than calling the fix forged', async () => {
    keys.useTest = false
    await paste(await sign([{ kid: 'x', kind: 'retry_set_aside' }]))
    expect(await screen.findByText(/cannot check fixes from support/)).toBeTruthy()
  })
})
