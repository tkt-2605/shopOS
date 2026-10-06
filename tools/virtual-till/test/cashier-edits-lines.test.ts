import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  migrate, bootstrap, newId, setSetting, setFeature, setUnits, setLadder, setCustomerLadder, setItemPrice,
  createCustomer, createBill, saveDraft, submitBill, productsByIds, saleUnitsFor, searchCustomers,
  pricingContextFor, resolveLinePrice, Ladder, Quantity, Money,
  type SqlDriver, type BootstrapResult, type ProductListItem, type CustomerListItem,
} from '@shopos/core'
import { openMemoryDatabase } from '@shopos/core/node'
import { MIGRATIONS } from '@shopos/core/migrations'
/* The counter's own cart, not a copy of it: what this bench is for is the
   distance between what the screen does and what the services were tested
   doing. `billCarts.ts` is plain TypeScript over `@shopos/core`. */
import {
  emptyCart, pricedForOf, repriceCart, snapshotOf, type Cart, type CartLine,
} from '../../../apps/pos/src/core/billCarts'

/**
 * A cashier at the counter, as a seeded random walk.
 *
 * The rest of this bench writes bills as rows and asks whether tills agree
 * about them. Nothing here or in core ever rang a bill up the way the counter
 * does -- add an item, change its unit, retype the quantity, choose the
 * customer last, hold it overnight -- and the counter charged one pack's price
 * for a box of fifty for as long as that was true (0.2.3).
 *
 * Each step is one thing a cashier does to the cart, then the cart settles as
 * the screen's effect settles it, and then autosave runs, as it does. At the
 * end of a bill the stored lines are held to the screen's, and every line
 * priced by the shop's rules and changed since the prices last moved is held
 * to those rules.
 */

const SEEDS = [20261007, 11, 909]
const BILLS = 12
const STEPS = 14

let db: SqlDriver
let seed: BootstrapResult
let actorId: string
let paper: ProductListItem
let pen: ProductListItem
let regular: CustomerListItem

function rng(n: number): () => number {
  let state = n >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  seed = await bootstrap(db, { shopName: 'Bench Stationery' })
  await setSetting(db, 'shop_state_code', '33')
  await setSetting(db, 'shop_gstin', '33ALNPJ1906G1ZC')
  actorId = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'owner', 'Owner', ?, 'x', ?, ?)`, [actorId, seed.roleIds['Admin']!, now, now])
  const ctx = { actorId }
  await setFeature(db, ctx, 'tieredPricing', true)

  const product = async (name: string, paise: number) => {
    const id = newId()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
       VALUES (?, ?, ?, 1200, '4802', ?, ?)`, [id, name, paise, now, now])
    return id
  }
  const paperId = await product('A4 Copier Paper', 34000)
  const penId = await product('Ball pen', 1000)
  await setUnits(db, ctx, paperId, [
    { saleUnit: 'ream', baseUnits: Quantity.fromUnits(10) }, { saleUnit: 'box', baseUnits: Quantity.fromUnits(50) },
  ])
  await setUnits(db, ctx, penId, [{ saleUnit: 'pack', baseUnits: Quantity.fromUnits(12) }])
  await ladder(paperId, [['10', '335'], ['50', '310']])
  await ladder(penId, [['1', '10'], ['24', '9']])

  const made = await createCustomer(db, ctx, { name: 'Ravi Traders', phone: '9876500000' })
  if (!made.ok) throw new Error(made.code)
  const theirs = Ladder.rowsToRungs([{ minQty: '1', rate: '300' }, { minQty: '20', rate: '290' }])
  if (!theirs.ok) throw new Error(theirs.code)
  await setCustomerLadder(db, ctx, { customerId: made.customerId, productId: paperId, saleUnit: 'piece', rungs: theirs.rungs })

  ;[paper, pen] = await productsByIds(db, [paperId, penId]) as [ProductListItem, ProductListItem]
  regular = (await searchCustomers(db, 'Ravi')).find((c) => c.id === made.customerId)!
})

afterEach(async () => { await db.close() })

async function ladder(productId: string, rows: [string, string][]) {
  const rungs = Ladder.rowsToRungs(rows.map(([minQty, rate]) => ({ minQty, rate })))
  if (!rungs.ok) throw new Error(rungs.code)
  const saved = await setLadder(db, { actorId }, { productId, priceListId: seed.priceListId, saleUnit: 'piece', rungs: rungs.rungs })
  if (!saved.ok) throw new Error(saved.code)
}

/** What `addProduct` on the counter does: one of the default unit, or one more of a line already there. */
async function scan(cart: Cart, product: ProductListItem): Promise<Cart> {
  const units = await saleUnitsFor(db, product.id)
  const unit = units.find((u) => u.isDefault) ?? units[0]!
  const at = cart.lines.findIndex((l) => l.product.id === product.id && l.saleUnit === unit.saleUnit && !l.manual)
  if (at >= 0) {
    return { ...cart, lines: cart.lines.map((l, i) => (i === at ? { ...l, qty: l.qty + 1 } : l)) }
  }
  const resolved = await resolveLinePrice(db, await pricingContextFor(db, cart.customer?.id ?? null), {
    productId: product.id, saleUnit: unit.saleUnit, qty: Quantity.fromUnits(1),
  })
  const line: CartLine = {
    key: newId(), product, saleUnit: unit.saleUnit, units, qty: 1,
    rate: resolved.rate, source: resolved.source, sourceId: resolved.sourceId, manual: false,
    includesTax: resolved.includesTax,
    pricedFor: pricedForOf({ saleUnit: unit.saleUnit, qty: 1 }, cart.customer?.id ?? null),
  }
  return { ...cart, lines: [...cart.lines, line] }
}

/** The screen's effect, run until it has nothing left to do. */
async function settle(cart: Cart): Promise<Cart> {
  return (await repriceCart(db, cart))(cart)
}

/** Autosave, as `useBillTabs` does it. */
async function autosave(cart: Cart): Promise<Cart> {
  if (cart.lines.length === 0) return cart
  const snap = snapshotOf(cart)
  const input = {
    registerId: seed.registerId, customerId: snap.customerId, lines: snap.lines,
    billDiscount: Money.paise(snap.billDiscount), convertedFrom: snap.convertedFrom, actorId,
  }
  const saved = cart.billId
    ? await saveDraft(db, { billId: cart.billId, ...input })
    : await createBill(db, input)
  if (!saved.ok) throw new Error(`autosave refused: ${JSON.stringify(saved)}`)
  return cart.billId ? cart : { ...cart, billId: (saved as { billId: string }).billId }
}

type Step = (cart: Cart, random: () => number) => Promise<Cart>

const pickOne = <T>(random: () => number, xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!

const STEPS_A_CASHIER_TAKES: Record<string, Step> = {
  scanPaper: async (cart) => scan(cart, paper),
  scanPen: async (cart) => scan(cart, pen),
  changeUnit: async (cart, random) => {
    if (cart.lines.length === 0) return cart
    const line = pickOne(random, cart.lines)
    const unit = pickOne(random, line.units).saleUnit
    return { ...cart, lines: cart.lines.map((l) => (l.key === line.key ? { ...l, saleUnit: unit } : l)) }
  },
  typeQty: async (cart, random) => {
    if (cart.lines.length === 0) return cart
    const line = pickOne(random, cart.lines)
    const qty = pickOne(random, [1, 2, 9, 10, 11, 24, 49, 50, 60])
    return { ...cart, lines: cart.lines.map((l) => (l.key === line.key ? { ...l, qty } : l)) }
  },
  chooseCustomer: async (cart, random) => ({ ...cart, customer: random() < 0.6 ? regular : null }),
  typeRate: async (cart, random) => {
    if (cart.lines.length === 0) return cart
    const line = pickOne(random, cart.lines)
    const rate = (Math.floor(random() * 300) + 1) * 100
    return {
      ...cart,
      lines: cart.lines.map((l) => (l.key === line.key ? { ...l, rate, manual: true, source: 'manual_override' as const, sourceId: null } : l)),
    }
  },
}

describe.each(SEEDS)('a cashier at the counter, seed %i', (n) => {
  it('is charged on every bill exactly what the screen showed, and the screen showed the shop’s prices', async () => {
    const random = rng(n)
    const names = Object.keys(STEPS_A_CASHIER_TAKES)

    for (let b = 0; b < BILLS; b++) {
      let cart = emptyCart()
      /** Lines changed since the prices last moved. Only these are held to today's prices. */
      const changedSince = new Set<string>()

      for (let s = 0; s < STEPS; s++) {
        const before = new Map(cart.lines.map((l) => [l.key, pricedForOf(l, cart.customer?.id ?? null)]))
        const name = pickOne(random, names)
        cart = await settle(await STEPS_A_CASHIER_TAKES[name]!(cart, random))
        for (const l of cart.lines) {
          if (before.get(l.key) !== pricedForOf(l, cart.customer?.id ?? null)) changedSince.add(l.key)
        }
        cart = await autosave(cart)

        // Held overnight, once in a while, and the owner moves a price.
        if (random() < 0.05) {
          await setItemPrice(db, { actorId }, {
            productId: paper.id, priceListId: seed.priceListId, saleUnit: 'piece',
            minQty: Quantity.fromUnits(50), rate: (31000 + Math.floor(random() * 10) * 100) as Money.Money,
          })
          changedSince.clear()
        }
      }
      if (cart.lines.length === 0 || !cart.billId) continue

      /* Rule 46(f): the counter will not take a large bill without a name on
         it, and says so. The cashier chooses the customer, the lines are
         priced for them, and the bill is taken. */
      const before = await db.get<{ grand_total: number }>(`SELECT grand_total FROM bills WHERE id = ?`, [cart.billId])
      if (cart.customer === null && before!.grand_total >= 5_000_000) {
        const keys = new Map(cart.lines.map((l) => [l.key, pricedForOf(l, null)]))
        cart = await autosave(await settle({ ...cart, customer: regular }))
        for (const l of cart.lines) if (keys.get(l.key) !== pricedForOf(l, regular.id)) changedSince.add(l.key)
      }

      const pricing = await pricingContextFor(db, cart.customer?.id ?? null)
      for (const line of cart.lines) {
        if (line.manual || !changedSince.has(line.key)) continue
        const rule = await resolveLinePrice(db, pricing, {
          productId: line.product.id, saleUnit: line.saleUnit, qty: Quantity.fromUnits(line.qty),
        })
        expect(line.rate, `seed ${n}, bill ${b}: ${line.qty} ${line.saleUnit} of ${line.product.name}`).toBe(rule.rate)
      }

      const billId = cart.billId!
      const total = await db.get<{ grand_total: number }>(`SELECT grand_total FROM bills WHERE id = ?`, [billId])
      const paid = await submitBill(db, {
        billId, payments: [{ method: 'cash', amount: total!.grand_total as Money.Money }], actorId,
      })
      expect(paid.ok, `seed ${n}, bill ${b}: ${JSON.stringify(paid)}`).toBe(true)

      const stored = await db.query<{ product_id: string; sale_unit: string; qty: number; rate: number }>(
        `SELECT product_id, sale_unit, qty, rate FROM bill_items WHERE bill_id = ? ORDER BY rowid`, [billId])
      expect(stored.map((r) => [r.product_id, r.sale_unit, r.qty, r.rate]).sort())
        .toEqual(cart.lines.map((l) => [l.product.id, l.saleUnit, Quantity.fromUnits(l.qty), l.rate]).sort())
    }
  })
})
