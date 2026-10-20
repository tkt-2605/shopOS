import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
  migrate, bootstrap, createUser, createCustomer, createBill, submitBill, noteBillEmail, Money, Quantity,
  type SqlDriver,
} from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { makeProduct } from '../../../packages/core/test/helpers'

/**
 * The line under a bill about its email: on the main, what it is waiting for;
 * on a counter, that the main will send it; in a shop with no main, that
 * nothing will until one is chosen; and anywhere, once sent, that it was.
 */

const core: { db: SqlDriver | null } = { db: null }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))
vi.mock('../src/core/billMail', () => ({ billMailReady: async () => null }))
const { BillEmailLine } = await import('../src/ui/BillEmailLine')

let db: SqlDriver
let billId = ''

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'TRT GENERAL STORE' })
  const made = await createUser(db, { username: 'owner', password: 'right-pass-9', roleId: seed.roleIds['Admin']! })
  if (!made.ok) throw new Error('no user')
  core.db = db
  const pen = await makeProduct(db, { name: 'Ball pen', baseRate: 1000, taxRateBp: 0 })
  const ravi = await createCustomer(db, { actorId: made.userId }, { name: 'Ravi', email: 'ravi@example.com', emailBills: true })
  if (!ravi.ok) throw new Error(ravi.code)
  await new Promise((r) => setTimeout(r, 5))
  const draft = await createBill(db, {
    registerId: seed.registerId, customerId: ravi.customerId, lines: [{ productId: pen, qty: Quantity.fromUnits(1) }], actorId: made.userId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(db, {
    billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal as Money.Money }], actorId: made.userId,
  })
  if (!done.ok) throw new Error(done.code)
  billId = draft.billId
})
afterEach(async () => { cleanup(); await db.close() })

const paired = (address: string | null) => db.execute(
  `INSERT INTO sync_peers (device_id, secret, address, created_at) VALUES ('other-till', 's', ?, ?)`,
  [address, new Date().toISOString()])

describe('the email line under a bill', () => {
  it('on a till on its own, says it will go within two minutes', async () => {
    render(<BillEmailLine billId={billId} />)
    expect(await screen.findByText('Will be emailed to ravi@example.com within two minutes.')).toBeTruthy()
  })

  it('on a counter, says the main till will send it', async () => {
    await paired('http://192.168.31.45:7801')
    await db.execute(`UPDATE sync_state SET main_device = 'other-till', main_epoch = 1 WHERE id = 1`)
    render(<BillEmailLine billId={billId} />)
    expect(await screen.findByText('Will be emailed to ravi@example.com by the main till.')).toBeTruthy()
  })

  it('in a shop with no main, says nothing is sent and where to choose one', async () => {
    await paired('http://192.168.31.45:7801')
    render(<BillEmailLine billId={billId} />)
    expect(await screen.findByText(/only the main till emails bills, and this shop has none yet/)).toBeTruthy()
    expect(screen.getByText(/Choose one in Settings, Other tills/)).toBeTruthy()
  })

  it('once some till has sent it, says so on any till', async () => {
    await paired('http://192.168.31.45:7801')
    await noteBillEmail(db, { billId, to: 'ravi@example.com' })
    render(<BillEmailLine billId={billId} />)
    expect(await screen.findByText(/^Emailed to ravi@example.com/)).toBeTruthy()
  })
})
