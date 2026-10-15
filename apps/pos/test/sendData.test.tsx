import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { migrate, bootstrap, createUser, type SqlDriver } from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'

/**
 * Sending the shop's data to support: only with the owner's password, made
 * once and sent as often as the line needs, and written down in the audit.
 * Against a real database; Rust is stood in for, and says what it was asked.
 */

const core: { db: SqlDriver | null } = { db: null }
const user = { id: '', username: 'owner', fullName: null, roleId: '', roleName: 'Admin', permissions: {} }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core, useUser: () => user }))
vi.mock('../src/core/backup', () => ({ chooseFolder: async () => 'D:\\To support' }))

const rust = {
  ready: true,
  sendFails: 0,
  asked: [] as { command: string; args: Record<string, unknown> | undefined }[],
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    rust.asked.push({ command, args })
    switch (command) {
      case 'support_data_ready': return rust.ready
      case 'support_data_make': return { id: '20261016030000', bytes: 3_400_000, customersHidden: 12 }
      case 'support_data_send':
        if (rust.sendFails > 0) { rust.sendFails -= 1; return { done: false, bytes: 3_400_000, error: 'The server did not answer in time.' } }
        return { done: true, bytes: 3_400_000, error: null }
      case 'support_data_save': return `${args!['folder']}\\ShopOS data.sod`
      case 'support_data_discard': return null
      default: throw new Error(`no command ${command}`)
    }
  },
}))
const { SendDataCard } = await import('../src/pages/settings/SendDataCard')

const asked = (command: string) => rust.asked.filter((a) => a.command === command)

beforeEach(async () => {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Test Shop' })
  const made = await createUser(db, { username: 'owner', password: 'right-pass-9', roleId: seed.roleIds['Admin']! })
  if (!made.ok) throw new Error('no user')
  user.id = made.userId
  core.db = db
  Object.assign(rust, { ready: true, sendFails: 0, asked: [] })
})
afterEach(async () => {
  cleanup()
  await core.db?.close()
})

function typePassword(value: string) {
  fireEvent.change(screen.getByLabelText('Your password'), { target: { value } })
}

describe('sending the shop data to support', () => {
  it('says what goes, who can open it and when it is deleted, before anything is made', async () => {
    render(<SendDataCard />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('only ShopOS support can open it')
    expect(text).toContain('deleted 30 days after it arrives')
    expect(text).toContain('Passwords and the recovery code are taken out first')
    expect((screen.getByLabelText(/Leave out customer details/) as HTMLInputElement).checked).toBe(true)
    expect(asked('support_data_make')).toEqual([])
  })

  it('makes nothing without the owner password', async () => {
    render(<SendDataCard />)
    typePassword('wrong')
    fireEvent.click(screen.getByText('Send to support'))
    expect(await screen.findByText('That is not your password.')).toBeTruthy()
    expect(asked('support_data_make')).toEqual([])
  })

  it('sends it, leaving out customers, and the audit says who and when', async () => {
    render(<SendDataCard />)
    fireEvent.change(screen.getByLabelText('What happened? (optional)'), { target: { value: 'bills not crossing' } })
    typePassword('right-pass-9')
    fireEvent.click(screen.getByText('Send to support'))
    expect(await screen.findByText(/Sent. Support has it/)).toBeTruthy()

    expect(asked('support_data_make')[0]!.args).toMatchObject({ anonymise: true, note: 'bills not crossing', madeBy: 'owner' })
    const audit = await core.db!.get<{ diff: string }>(`SELECT diff FROM audit_log WHERE entity_id = 'support_data'`)
    expect(audit?.diff).toContain('20261016030000')
  })

  it('carries on a broken upload without making the file again', async () => {
    rust.sendFails = 1
    render(<SendDataCard />)
    typePassword('right-pass-9')
    fireEvent.click(screen.getByText('Send to support'))
    expect(await screen.findByText(/stopped part of the way/)).toBeTruthy()

    fireEvent.click(screen.getByText('Send again'))
    expect(await screen.findByText(/Sent. Support has it/)).toBeTruthy()
    expect(asked('support_data_make')).toHaveLength(1)
    expect(asked('support_data_send')).toHaveLength(2)
  })

  it('saves it to a folder instead, for a shop with no line', async () => {
    render(<SendDataCard />)
    typePassword('right-pass-9')
    fireEvent.click(screen.getByText('Save to a file instead…'))
    expect(await screen.findByText(/Saved to D:\\To support/)).toBeTruthy()
    expect(asked('support_data_send')).toEqual([])
  })

  it('says so plainly when the build has no support key', async () => {
    rust.ready = false
    render(<SendDataCard />)
    await waitFor(() => expect(document.body.textContent).toContain('built without the support key'))
    expect(screen.queryByText('Send to support')).toBeNull()
  })
})
