import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  migrate, bootstrap, newId, setFeature, setUnits, setLadder, productsByIds, saleUnitsFor, Ladder, Quantity,
  createCustomer, setCustomerLadder,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* The node driver is reached around `@shopos/core` on purpose: see
   `invoiceFromBill.test.tsx`. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { emptyCart, repriceCart, linesToReprice, pricedForOf, type Cart, type CartLine } from '../src/core/billCarts'

/**
 * A line's rate follows its unit, its quantity and the bill's customer.
 *
 * Reported from a shop: A4 copier paper at ₹340 a pack, ten or more at ₹335,
 * fifty or more at ₹310, sold also as a ream of ten and a box of fifty. Added
 * at the counter as one pack and switched to a box, the line went on saying
 * ₹340 -- one pack's price for fifty -- and the bill charged it, because the
 * service takes the screen's rate as already resolved.
 */

let db: SqlDriver
let seed: BootstrapResult
let adminId: string
let paper: string

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'TRT Stationery' })
  adminId = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, seed.roleIds['Admin']!, now, now],
  )
  paper = newId()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
     VALUES (?, 'A4 Copier Paper 500 sheets', 34000, 1200, '4802', ?, ?)`,
    [paper, now, now],
  )
  const ctx = { actorId: adminId }
  await setFeature(db, ctx, 'tieredPricing', true)
  const units = await setUnits(db, ctx, paper, [
    { saleUnit: 'ream', baseUnits: Quantity.fromUnits(10) },
    { saleUnit: 'box', baseUnits: Quantity.fromUnits(50) },
  ])
  if (!units.ok) throw new Error(units.code)
  const rungs = Ladder.rowsToRungs([{ minQty: '10', rate: '335' }, { minQty: '50', rate: '310' }])
  if (!rungs.ok) throw new Error(rungs.code)
  const ladder = await setLadder(db, ctx, {
    productId: paper, priceListId: seed.priceListId, saleUnit: 'piece', rungs: rungs.rungs,
  })
  if (!ladder.ok) throw new Error(ladder.code)
})

afterEach(async () => { await db.close() })

/** One pack, as the counter adds it: priced for one of its default unit. */
async function cartWithOnePack(): Promise<Cart> {
  const [product] = await productsByIds(db, [paper])
  const line: CartLine = {
    key: 'line-1', product: product!, saleUnit: 'piece', units: await saleUnitsFor(db, paper),
    qty: 1, rate: 34000, source: 'base_rate', sourceId: null, manual: false, includesTax: true,
    pricedFor: pricedForOf({ saleUnit: 'piece', qty: 1 }, null),
  }
  return { ...emptyCart(), lines: [line] }
}

const edit = (cart: Cart, change: Partial<CartLine>): Cart =>
  ({ ...cart, lines: cart.lines.map((l) => ({ ...l, ...change })) })

async function settle(cart: Cart): Promise<CartLine> {
  return (await repriceCart(db, cart))(cart).lines[0]!
}

describe('a line priced again when it changes', () => {
  it('leaves a line alone that is as it was priced', async () => {
    const cart = await cartWithOnePack()
    expect(linesToReprice(cart)).toEqual([])
    expect((await settle(cart)).rate).toBe(34000)
  })

  it('charges a box of fifty at the fifty-or-more rate, fifty times', async () => {
    const line = await settle(edit(await cartWithOnePack(), { saleUnit: 'box' }))
    expect(line.rate).toBe(1_550_000)
    expect(line.source).toBe('default_list')
  })

  it('charges a ream of ten at the ten-or-more rate', async () => {
    expect((await settle(edit(await cartWithOnePack(), { saleUnit: 'ream' }))).rate).toBe(335_000)
  })

  it('reaches a rung when the quantity is typed up to it, and leaves it when typed back', async () => {
    const ten = await settle(edit(await cartWithOnePack(), { qty: 10 }))
    expect(ten.rate).toBe(33_500)
    const cart = { ...(await cartWithOnePack()), lines: [ten] }
    expect((await settle(edit(cart, { qty: 3 }))).rate).toBe(34_000)
  })

  it('never touches a rate the cashier typed', async () => {
    const typed = edit(await cartWithOnePack(), { manual: true, source: 'manual_override', rate: 30000, saleUnit: 'box' })
    expect(linesToReprice(typed)).toEqual([])
    expect((await settle(typed)).rate).toBe(30000)
  })

  it('never touches a rate an order promised', async () => {
    const promised = edit(await cartWithOnePack(), { source: 'order_rate', sourceId: 'order-1', qty: 50 })
    expect((await settle(promised)).rate).toBe(34000)
  })

  it('takes the customer’s own price once the customer is chosen', async () => {
    const made = await createCustomer(db, { actorId: adminId }, { name: 'Ravi Traders', phone: '9876543210' })
    if (!made.ok) throw new Error(made.code)
    const theirs = Ladder.rowsToRungs([{ minQty: '1', rate: '300' }])
    if (!theirs.ok) throw new Error(theirs.code)
    const saved = await setCustomerLadder(db, { actorId: adminId }, {
      customerId: made.customerId, productId: paper, saleUnit: 'piece', rungs: theirs.rungs,
    })
    if (!saved.ok) throw new Error(saved.code)

    const cart = await cartWithOnePack()
    const withCustomer: Cart = { ...cart, customer: { id: made.customerId } as Cart['customer'] }
    const line = await settle(withCustomer)
    expect(line.rate).toBe(30000)
    expect(line.source).toBe('customer_override')
  })

  it('does not hand a rate to a line that changed again while it was being worked out', async () => {
    const asked = edit(await cartWithOnePack(), { saleUnit: 'box' })
    const change = await repriceCart(db, asked)
    const typedOn = edit(asked, { qty: 2 })
    const after = change(typedOn).lines[0]!
    expect(after.rate).toBe(34000)
    expect(linesToReprice({ ...typedOn, lines: [after] })).toHaveLength(1)
  })
})
