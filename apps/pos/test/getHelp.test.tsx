import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { migrate, bootstrap, getSetting, shortShopId, type SqlDriver } from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { supportCode, supportLine, spokenShop, helpMessage } from '../src/core/support'

/**
 * Getting help from the counter: the support code a shopkeeper reads out, the
 * chat that opens already saying which shop is asking, and remote help.
 *
 * Against a real database, because the code is made from the shop's own id and
 * this till's counter, and Rust standing in for what it answers.
 */

const core: { db: SqlDriver | null } = { db: null }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

let registerId = ''
vi.mock('../src/core/device', () => ({ chosenRegister: () => registerId, deviceSetting: () => null, setDeviceSetting: async () => true }))
vi.mock('../src/core/version', () => ({ appVersion: async () => ({ version: '0.3.0', schema: 72, shop: null }) }))

const rust: {
  phone: string | null
  whatsapp: boolean
  remote: unknown
  sent: string[]
} = { phone: null, whatsapp: false, remote: { outcome: 'notInstalled' }, sent: [] }

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: { text?: string }) => {
    if (command === 'support_contact') return { phone: rust.phone, whatsapp: rust.whatsapp }
    if (command === 'support_whatsapp') { rust.sent.push(args!.text!); return null }
    if (command === 'start_remote_help') return rust.remote
    throw new Error(`no command ${command}`)
  },
}))
const { GetHelp } = await import('../src/ui/GetHelp')

let shop = ''

beforeEach(async () => {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Test Shop' })
  registerId = seed.registerId
  shop = shortShopId((await getSetting(db, 'shop_id'))!)
  core.db = db
  Object.assign(rust, { phone: null, whatsapp: false, remote: { outcome: 'notInstalled' }, sent: [] })
})
afterEach(async () => {
  cleanup()
  await core.db?.close()
})

describe('the support code', () => {
  it('is the short shop id, so support finds the shop the reports and releases already name', () => {
    const code = supportCode({ shopId: '0192f4a1-77aa-7bcd-8000-000000000000', counterPrefix: 'FC', version: '0.3.0' })
    expect(supportLine(code)).toBe('0192f4a1 · FC · 0.3.0')
    expect(spokenShop(code.shop!)).toBe('0192 f4a1')
  })

  it('still says something before the shop is set up', () => {
    expect(supportLine(supportCode({ shopId: null, counterPrefix: null, version: '0.3.0' }))).toBe('no shop yet · 0.3.0')
  })

  it('opens the message with the code, for the shopkeeper to finish', () => {
    const code = supportCode({ shopId: '0192f4a1', counterPrefix: 'FC', version: '0.3.0' })
    expect(helpMessage(code)).toContain('Support code: 0192f4a1 · FC · 0.3.0')
  })
})

describe('the Get help screen', () => {
  it('shows this shop and this counter', async () => {
    render(<GetHelp onClose={() => {}} />)
    expect(await screen.findByText(spokenShop(shop))).toBeTruthy()
    expect(screen.getByText('version 0.3.0')).toBeTruthy()
    expect(document.body.textContent).toMatch(/counter \S+/)
  })

  it('says plainly when the build has no support number, and names the file', async () => {
    render(<GetHelp onClose={() => {}} />)
    expect(await screen.findByText(/has no support number/)).toBeTruthy()
    expect(document.body.textContent).toContain('apps/pos/src-tauri/.env')
    expect(screen.queryByText('Message on WhatsApp')).toBeNull()
  })

  it('opens WhatsApp with the support code already in the message', async () => {
    Object.assign(rust, { phone: '+91 98765 43210', whatsapp: true })
    render(<GetHelp onClose={() => {}} />)
    expect(await screen.findByText('+91 98765 43210')).toBeTruthy()
    fireEvent.click(screen.getByText('Message on WhatsApp'))
    await waitFor(() => expect(rust.sent).toHaveLength(1))
    expect(rust.sent[0]).toContain(`Support code: ${shop}`)
  })

  it('says which program opened for remote help', async () => {
    rust.remote = { outcome: 'started', program: 'RustDesk' }
    render(<GetHelp onClose={() => {}} />)
    fireEvent.click(await screen.findByText('Start remote help'))
    expect(await screen.findByText(/RustDesk is open/)).toBeTruthy()
  })

  it('says when there is no remote-help program, rather than doing nothing', async () => {
    render(<GetHelp onClose={() => {}} />)
    fireEvent.click(await screen.findByText('Start remote help'))
    expect(await screen.findByText(/Neither RustDesk nor AnyDesk/)).toBeTruthy()
  })
})
