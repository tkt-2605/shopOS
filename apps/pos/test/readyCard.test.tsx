import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { migrate, bootstrap, type SqlDriver } from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'

/**
 * Ready for a bad day: each tick read from what the shop has set up, so it
 * cannot say ready when the recovery code was never made.
 */

const core: { db: SqlDriver | null } = { db: null }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))
const machine = new Map<string, string>()
vi.mock('../src/core/device', () => ({ deviceSetting: (k: string) => machine.get(k) ?? null }))
const build = { daily: false, sealed: false, phone: null as string | null }
vi.mock('../src/core/reportOut', () => ({ healthGoesDaily: async () => build.daily }))
vi.mock('../src/core/supportData', () => ({ supportDataReady: async () => build.sealed }))
vi.mock('../src/core/support', () => ({ supportContact: async () => ({ phone: build.phone, whatsapp: false }) }))
/* Rust's answer (`backup_folder_leaves_machine`), from the folder this test chose: anywhere but C: leaves. */
vi.mock('../src/core/backupFolder', () => ({
  backupFolderLeavesMachine: async () => {
    const folder = machine.get('backup_folder')
    return folder === undefined ? null : !/^c:/i.test(folder)
  },
}))
const { ReadyCard } = await import('../src/pages/settings/ReadyCard')

beforeEach(async () => {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  await bootstrap(db, { shopName: 'Test Shop' })
  core.db = db
  machine.clear()
  Object.assign(build, { daily: false, sealed: false, phone: null })
})
afterEach(async () => { cleanup(); await core.db?.close() })

describe('ready for a bad day', () => {
  it('says what is missing, and how to put it right', async () => {
    await core.db!.execute(`DELETE FROM settings WHERE key = 'recovery_code_hash'`)
    render(<ReadyCard />)
    expect(await screen.findByText('Ready for a bad day: 4 to do')).toBeTruthy()
    expect(document.body.textContent).toContain('a forgotten owner password cannot be reset at the shop')
  })

  it('is ready when everything is set up, and shows the number to save', async () => {
    await core.db!.execute(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('recovery_code_hash', 'h', '2026-10-18')`)
    machine.set('backup_folder', 'E:\\backups')
    Object.assign(build, { daily: true, sealed: true, phone: '+91 98765 43210' })
    render(<ReadyCard />)
    expect(await screen.findByText('Ready for a bad day')).toBeTruthy()
    expect(document.body.textContent).toContain('Save support\'s number in the shop\'s phone: +91 98765 43210')
  })

  it('does not count a backup folder on the computer\'s own disk as off it', async () => {
    await core.db!.execute(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('recovery_code_hash', 'h', '2026-10-18')`)
    machine.set('backup_folder', 'C:\\Backups')
    Object.assign(build, { daily: true, sealed: true })
    render(<ReadyCard />)
    expect(await screen.findByText('Ready for a bad day: 1 to do')).toBeTruthy()
    expect(document.body.textContent).toContain('on this computer\'s own disk')
  })
})
