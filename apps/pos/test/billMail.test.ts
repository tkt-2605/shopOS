import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCustomer, createBill, submitBill, billEmailNote, type SqlDriver } from '@shopos/core'
import { freshDb, makeProduct } from '../../../packages/core/test/helpers'

/**
 * The main till's pass over bills to email: each ticked customer's bill handed
 * to Rust once, with its own invoice page, and noted so it never goes twice.
 */

const calls: { command: string; args: Record<string, unknown> }[] = []
const rust = { ready: null as string | null, fail: null as string | null }
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args })
    if (command === 'bill_mail_ready') return rust.ready
    if (command === 'bill_mail') {
      if (rust.fail) throw new Error(rust.fail)
      return { mail: 'queued', error: null }
    }
    return null
  },
}))
vi.mock('../src/core/log', () => ({ logEvent: () => {} }))
const machine = new Map<string, string>()
vi.mock('../src/core/device', () => ({
  deviceSetting: (k: string) => machine.get(k) ?? null,
  setDeviceSetting: async (k: string, v: string | null) => { if (v === null) machine.delete(k); else machine.set(k, v); return true },
}))
const { sendDueBills, letterFor } = await import('../src/core/billMail')

let db: SqlDriver
let actor = ''
let register = ''

beforeEach(async () => {
  const fx = await freshDb()
  db = fx.db
  actor = fx.adminId
  register = fx.seed.registerId
  calls.length = 0
  Object.assign(rust, { ready: null, fail: null })
  // This till has been the sender since long before any of these bills.
  machine.clear()
  machine.set('bill_mail_since', '2000-01-01T00:00:00.000Z')
})
afterEach(async () => { await db.close() })

async function billFor(email: string | null, emailBills: boolean): Promise<string> {
  const c = await createCustomer(db, { actorId: actor }, { name: 'Ravi', email, emailBills })
  if (!c.ok) throw new Error(c.code)
  const product = await makeProduct(db, { name: 'Pen', baseRate: 1000 as never, taxRateBp: 0 })
  const draft = await createBill(db, { registerId: register, customerId: c.customerId, lines: [{ productId: product, qty: 10_000 as never }], actorId: actor })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: actor })
  if (!done.ok) throw new Error(done.code)
  return draft.billId
}

describe('emailing bills from the main', () => {
  it('hands a ticked customer\'s bill to Rust once, with its invoice page', async () => {
    const bill = await billFor('ravi@example.com', true)
    expect(await sendDueBills(db)).toBe(1)
    const sent = calls.find((c) => c.command === 'bill_mail')!
    expect(sent.args).toMatchObject({ to: 'ravi@example.com' })
    expect(String(sent.args['html'])).toContain('<html')
    expect(String(sent.args['subject'])).toContain('Test Shop')
    expect(await billEmailNote(db, bill)).toMatchObject({ to: 'ravi@example.com', error: null })

    calls.length = 0
    expect(await sendDueBills(db), 'never twice').toBe(0)
    expect(calls.some((c) => c.command === 'bill_mail')).toBe(false)
  })

  it('leaves everyone else alone', async () => {
    await billFor('ravi@example.com', false)
    expect(await sendDueBills(db)).toBe(0)
    expect(calls).toEqual([])
  })

  it('waits, without noting anything, while the till has no mail set up', async () => {
    const bill = await billFor('ravi@example.com', true)
    rust.ready = 'Set up the shop\'s email in Settings'
    expect(await sendDueBills(db)).toBe(0)
    expect(await billEmailNote(db, bill), 'tried again once it is set up').toBeNull()
  })

  it('notes why, when the PDF could not be made', async () => {
    const bill = await billFor('ravi@example.com', true)
    rust.fail = 'Edge took too long to make the PDF.'
    await sendDueBills(db)
    expect(await billEmailNote(db, bill)).toMatchObject({ error: 'Edge took too long to make the PDF.' })
  })

  it('starts from when it took on sending, so a new main never resends the old main’s bills', async () => {
    await billFor('ravi@example.com', true)
    machine.clear()
    expect(await sendDueBills(db, new Date(Date.now() + 1000))).toBe(0)
    expect(machine.get('bill_mail_since')).toBeDefined()
    await new Promise((r) => setTimeout(r, 1100))
    await billFor('ravi@example.com', true)
    expect(await sendDueBills(db), 'a bill rung after it took over goes').toBe(1)
  })

  it('writes to the customer by name, and says how to reach the shop', () => {
    const letter = letterFor(
      { billId: 'b', docNo: 'BMR/2627/00012', grandTotal: 123450 as never, customerName: 'Ravi', to: 'ravi@example.com' },
      { name: 'TRT Stationery', phone: '+91 73970 86633' },
    )
    expect(letter.subject).toBe('Invoice BMR/2627/00012 from TRT Stationery')
    expect(letter.body).toContain('Dear Ravi')
    expect(letter.body).toContain('+91 73970 86633')
  })
})
