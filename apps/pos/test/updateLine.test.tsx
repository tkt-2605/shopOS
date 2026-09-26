import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import {
  migrate, bootstrap, createUser, getOrOpenSession,
  type SqlDriver, type UpdateSource, type AvailableUpdate,
} from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'

/**
 * The updater, mounted, with a source standing in for the plugin.
 *
 * `UpdateSource` and `createUpdater` were an interface and a loop that nothing
 * called and nothing tested. This is the seam used the way the sidebar uses
 * it -- found, fetched, offered, and installed only when the drawer is shut --
 * against a real database, because the drawer is a row in it.
 */

const core: { db: SqlDriver | null } = { db: null }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))
const { UpdateLine } = await import('../src/ui/UpdateLine')

const NEXT: AvailableUpdate = { version: '0.2.0', notes: '', publishedAt: null }

function source(found: AvailableUpdate | null) {
  const installed = vi.fn(async () => {})
  const it: UpdateSource = {
    check: async () => found,
    download: async () => {},
    install: installed,
  }
  return { it, installed }
}

let registerId = ''
let userId = ''

beforeEach(async () => {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Test Shop' })
  registerId = seed.registerId
  const made = await createUser(db, { username: 'ravi', password: 'counter-9', roleId: seed.roleIds['Admin']! })
  if (!made.ok) throw new Error('no user')
  userId = made.userId
  core.db = db
})
afterEach(async () => {
  cleanup()
  await core.db?.close()
})

describe('the update line', () => {
  it('says nothing when there is nothing new, which is every build without a feed', async () => {
    const { it: none } = source(null)
    const { container } = render(<UpdateLine source={none} />)
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toBe('')
  })

  it('fetches what it finds and offers it, then installs when asked', async () => {
    const { it: found, installed } = source(NEXT)
    render(<UpdateLine source={found} />)

    const install = await screen.findByRole('button', { name: 'Install now' }, { timeout: 5000 })
    expect(screen.getByRole('status').textContent).toMatch(/0\.2\.0 is ready to install/)
    await act(async () => { fireEvent.click(install) })
    expect(installed).toHaveBeenCalledTimes(1)
  })

  it('will not install while a drawer is open, and says which one', async () => {
    await getOrOpenSession(core.db!, { registerId, userId })
    const { it: found, installed } = source(NEXT)
    render(<UpdateLine source={found} />)

    const install = await screen.findByRole('button', { name: 'Install now' }, { timeout: 5000 })
    await act(async () => { fireEvent.click(install) })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/drawer/i))
    expect(installed).not.toHaveBeenCalled()
  })
})
