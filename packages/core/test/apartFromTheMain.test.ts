import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { processReturn } from '../src/services/returns.js'
import { recordPayment, cancelPayment } from '../src/services/payments.js'
import { paySupplier, supplierOwed } from '../src/services/payables.js'
import { createSupplier } from '../src/services/suppliers.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { currentStock, recomputeStock } from '../src/services/stock.js'
import { customerOutstanding } from '../src/services/payments/outstanding.js'
import { findDiscrepancies, applyRemedy } from '../src/services/discrepancies.js'
import { ensureOwnRegister } from '../src/services/registers.js'
import { ledgerChecks, partyBalance } from '../src/repos/ledger.js'
import { REPLICATED } from '../src/domain/replicaShape.js'
import { setDeviceId } from '../src/device.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { amendBill } from '../src/services/billing.js'
import { cancelReturn } from '../src/services/returns.js'
import { cancelStockEntry } from '../src/services/stockEntry.js'
import { applyAdvance } from '../src/services/payments.js'
import { setProductActive } from '../src/services/products.js'
import { archiveCustomer } from '../src/services/customers.js'
import { createDocument, submitDocument } from '../src/services/documents.js'
import { documentToCart } from '../src/services/convert.js'
import { setSetting } from '../src/services/bootstrap.js'
import { openCount, setCounted, submitCount } from '../src/services/stockCount.js'
import { freshDb, emptyDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { as, pull, type Till } from './twoTills.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * The main is off, and two counters do the same thing to the same record.
 *
 * Neither counter can see the other: in a shop with one main they only ever
 * speak to the main, and it is not there. So each does something that is
 * right on its own -- cancels the bill, takes the refund, records the payment
 * -- and wrong together. No counter can refuse what it cannot know about.
 * What the shop is owed instead, once the main is back and everyone has synced:
 *
 *   * nothing silently lost, and all three tills holding the same books;
 *   * the books still the books -- every voucher balanced, the stock account
 *     agreeing with the stock ledger, stock on hand what the ledger adds up to;
 *   * the double action either settled to one (a bill is cancelled once, its
 *     goods go back once) or put in front of a person (`findDiscrepancies`).
 */

const MAIN = '11111111-1111-4111-8111-111111111111'
const C1 = '22222222-2222-4222-8222-222222222222'
const C2 = '33333333-3333-4333-8333-333333333333'

let fx: Fixture
let main: Till
let c1: Till
let c2: Till
let counterOf: Map<string, string>
let product: string
let customer: string
let seeded: Map<string, Set<string>>

beforeEach(async () => {
  fx = await freshDb()
  main = { id: MAIN, db: fx.db }
  c1 = { id: C1, db: await emptyDb() }
  c2 = { id: C2, db: await emptyDb() }

  /* What a migration writes on every till for itself, from a till that has
     only been migrated -- allowed its own timestamps. See `virtual-till`'s
     `books.ts`, which this follows. */
  seeded = new Map()
  const bare = await emptyDb()
  for (const [table, rows] of await held(bare)) seeded.set(table, new Set(rows.keys()))
  await bare.close()

  product = await makeProduct(main.db, { name: 'Shirt', baseRate: rupees(500), taxRateBp: 0 })
  customer = await makeCustomer(main.db, 'Ravi')
  await main.db.execute(`UPDATE customers SET credit_limit = ? WHERE id = ?`, [rupees(1500), customer])
  await as(MAIN, () => stockIn(main, 10))

  await pull(c1, main)
  await pull(c2, main)
  counterOf = new Map([[MAIN, fx.seed.registerId]])
  for (const c of [c1, c2]) {
    counterOf.set(c.id, (await as(c.id, () => ensureOwnRegister(c.db)))!)
  }
  await settle()
})

afterEach(async () => {
  setDeviceId(null)
  for (const t of [main, c1, c2]) await t.db.close()
})

// --- the shop's moves ---------------------------------------------------------

async function stockIn(t: Till, units: number): Promise<string> {
  const entry = await createStockEntry(t.db, {
    entryType: 'purchase',
    lines: [{ productId: product, qty: fromUnits(units), unitCost: rupees(300) }],
    actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error(entry.code)
  const done = await submitStockEntry(t.db, { entryId: entry.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
  return entry.entryId
}

async function sell(
  t: Till, units: number, opts: { credit?: boolean; redeem?: number } = {},
): Promise<{ billId: string; itemId: string; total: Money }> {
  return as(t.id, async () => {
    const draft = await createBill(t.db, {
      registerId: counterOf.get(t.id)!,
      customerId: customer,
      lines: [{ productId: product, qty: fromUnits(units) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)
    const done = await submitBill(t.db, {
      billId: draft.billId,
      payments: [{
        method: opts.credit ? 'credit' : 'cash',
        amount: (draft.grandTotal - rupees(opts.redeem ?? 0)) as Money,
      }],
      ...(opts.redeem ? { redeemPoints: opts.redeem } : {}),
      actorId: fx.adminId,
    })
    if (!done.ok) throw new Error(`${done.code} ${'reason' in done ? String(done.reason) : ''}`)
    const item = await t.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [draft.billId])
    return { billId: draft.billId, itemId: item!.id, total: draft.grandTotal }
  })
}

/** The main comes back, and every counter syncs with it until nothing moves. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await pull(c1, main)
    await pull(c2, main)
  }
}

// --- what the shop holds afterwards -----------------------------------------------

type Row = Record<string, unknown>

async function held(db: SqlDriver): Promise<Map<string, Map<string, Row>>> {
  const out = new Map<string, Map<string, Row>>()
  const dump = async (table: string, key: string | null) => {
    const rows = await db.query<Row>(`SELECT * FROM "${table}"`)
    return new Map(rows.map((r) => [key !== null ? String(r[key]) : 'id' in r ? String(r['id']) : JSON.stringify(r), r]))
  }
  for (const shape of REPLICATED) {
    const rows = await dump(shape.table, shape.key)
    // A bill nobody has rung up stays on the till typing it (042).
    const drafts = shape.table === 'bills'
      ? new Set([...rows].filter(([, r]) => Number(r['docstatus']) === 0).map(([id]) => id)) : new Set<string>()
    for (const id of drafts) rows.delete(id)
    out.set(shape.table, rows)
    for (const line of shape.lines) {
      const lines = await dump(line.table, null)
      for (const [id, r] of lines) if (drafts.has(String(r[line.parentKey]))) lines.delete(id)
      out.set(line.table, lines)
    }
  }
  return out
}

const PROVENANCE = new Set(['created_at', 'updated_at', 'rev'])

/** Rows on which the three tills do not hold the same thing. */
async function differences(): Promise<string[]> {
  const [a, ...others] = await Promise.all([main, c1, c2].map((t) => held(t.db)))
  const found: string[] = []
  for (const [i, b] of others.entries()) {
    for (const [table, mine] of a!) {
      const yours = b.get(table) ?? new Map<string, Row>()
      for (const id of new Set([...mine.keys(), ...yours.keys()])) {
        const x = mine.get(id)
        const y = yours.get(id)
        if (x === undefined || y === undefined) { found.push(`c${i + 1} ${table} ${id}: missing on one side`); continue }
        const incidental = REPLICATED.find((r) => r.table === table)?.incidental ?? []
        const cols = Object.keys(x).filter((c) => !incidental.includes(c)
          && !(seeded.get(table)?.has(id) && PROVENANCE.has(c)))
        const col = cols.find((c) => String(x[c]) !== String(y[c]))
        if (col !== undefined) found.push(`c${i + 1} ${table} ${id}: ${col} ${String(x[col])} vs ${String(y[col])}`)
      }
    }
  }
  return found
}

/** Everything a shopkeeper and an accountant would ask of the shop afterwards. */
async function afterwards() {
  const tills = []
  for (const t of [main, c1, c2]) {
    const checks = await ledgerChecks(t.db)
    tills.push({
      till: t.id.slice(0, 2),
      unbalanced: checks.unbalanced.length,
      stockAccountDrift: checks.stockDrift,
      shelfDrift: (await recomputeStock(t.db)).length,
      told: (await findDiscrepancies(t.db)).map((d) => d.kind).sort(),
    })
  }
  return { tills, differences: await differences() }
}

/**
 * What every scenario ends with: the three tills hold the same books, the books
 * are the books, and every till tells the shop what it needs to hear. A
 * counter's own list can carry more than this -- which edit a merge dropped is
 * written down on the till that dropped it -- so `told` is what each must have.
 */
async function expectSettled(told: readonly string[] = []): Promise<void> {
  const after = await afterwards()
  expect(after.differences, 'all three tills hold the same books').toEqual([])
  for (const t of after.tills) {
    expect(t.unbalanced, `${t.till}: every voucher balances`).toBe(0)
    expect(t.stockAccountDrift, `${t.till}: the stock account agrees with the stock ledger`).toBe(0)
    expect(t.shelfDrift, `${t.till}: stock on hand is what the ledger adds up to`).toBe(0)
    for (const kind of told) expect(t.told, `${t.till} tells the shop`).toContain(kind)
  }
}


/**
 * The warning's own way out: it names the documents to choose between, and
 * cancelling the one that should not stand -- from the warning, as the
 * dashboard does -- makes the warning go, on every till, with the books whole.
 */
async function putRight(kind: string, cancels: 'cancel_payment' | 'cancel_return' | 'cancel_bill'): Promise<void> {
  const warning = (await findDiscrepancies(main.db)).find((d) => d.kind === kind)
  expect(warning?.remedies?.map((r) => r.act), `${kind} offers a way out`).toEqual([cancels, cancels])
  for (const r of warning!.remedies!) {
    expect(r.where, `${r.docNo} says which counter`).not.toBeNull()
  }
  const done = await as(MAIN, () => applyRemedy(main.db, warning!.remedies![1]!, fx.adminId))
  expect(done).toMatchObject({ ok: true })
  await settle()
  for (const t of [main, c1, c2]) {
    expect((await findDiscrepancies(t.db)).map((d) => d.kind), `${kind} is put right`).not.toContain(kind)
  }
  await expectSettled()
}

const shelf = (t: Till) => currentStock(t.db, product)

// --- the scenarios ---------------------------------------------------------------------

describe('the main is off and both counters act on the same record', () => {
  it('1 cancel one bill on both counters', async () => {
    const sale = await sell(main, 1)
    await settle()
    await as(C1, () => cancelBill(c1.db, { billId: sale.billId, reason: 'c1', actorId: fx.adminId }))
    await as(C2, () => cancelBill(c2.db, { billId: sale.billId, reason: 'c2', actorId: fx.adminId }))
    await settle()
    // Ten in, one sold, one put back -- once: ten, not eleven.
    expect(await shelf(main)).toBe(fromUnits(10))
    await expectSettled()
  })

  it('2 refund one bill in full on both counters', async () => {
    const sale = await sell(main, 1)
    await settle()
    for (const c of [c1, c2]) {
      const r = await as(c.id, () => processReturn(c.db, {
        billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
      }))
      expect(r.ok).toBe(true)
    }
    await settle()
    // Both refunds stand; the shelf shows the item back twice, and the shop is told.
    expect(await shelf(main)).toBe(fromUnits(11))
    await expectSettled(['refunded_twice'])
    await putRight('refunded_twice', 'cancel_return')
    expect(await shelf(main), 'one item back, once').toBe(fromUnits(10))
  })

  it('3 refund on one counter, cancel on the other', async () => {
    const sale = await sell(main, 1)
    await settle()
    await as(C1, () => processReturn(c1.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
    }))
    await as(C2, () => cancelBill(c2.db, { billId: sale.billId, reason: 'c2', actorId: fx.adminId }))
    await settle()
    expect(await shelf(main)).toBe(fromUnits(11))
    await expectSettled(['refunded_and_cancelled'])
    const both = (await findDiscrepancies(main.db)).find((d) => d.kind === 'refunded_and_cancelled')
    expect(both?.remedies?.map((r) => r.act)).toEqual(['cancel_return'])
    expect(await as(MAIN, () => applyRemedy(main.db, both!.remedies![0]!, fx.adminId))).toMatchObject({ ok: true })
    await settle()
    expect(await shelf(main), 'the cancel put it back; the return no longer does as well').toBe(fromUnits(10))
    await expectSettled()
  })

  it('4 a credit bill paid in full on both counters', async () => {
    const sale = await sell(main, 1, { credit: true })
    await settle()
    for (const c of [c1, c2]) {
      await as(c.id, () => recordPayment(c.db, {
        customerId: customer, amount: sale.total, method: 'cash',
        allocations: [{ billId: sale.billId, amount: sale.total }], registerId: counterOf.get(c.id)!, actorId: fx.adminId,
      }))
    }
    await settle()
    expect(await customerOutstanding(main.db, customer)).toBe(-rupees(500))
    await expectSettled(['paid_twice'])
    // And it says whose account, so the screen can open it at the payment to cancel.
    const warning = (await findDiscrepancies(main.db)).find((d) => d.kind === 'paid_twice')
    expect(warning?.customerId).toBe(customer)
    await putRight('paid_twice', 'cancel_payment')
    expect(await customerOutstanding(main.db, customer), 'paid once').toBe(0)
  })

  it('5 one payment cancelled on both counters', async () => {
    const sale = await sell(main, 1, { credit: true })
    const paid = await as(MAIN, () => recordPayment(main.db, {
      customerId: customer, amount: sale.total, method: 'cash',
      allocations: [{ billId: sale.billId, amount: sale.total }], registerId: fx.seed.registerId, actorId: fx.adminId,
    }))
    if (!paid.ok) throw new Error(paid.code)
    await settle()
    for (const c of [c1, c2]) await as(c.id, () => cancelPayment(c.db, { paymentId: paid.paymentId, actorId: fx.adminId }))
    await settle()
    // Cancelled once: the bill is owed again, once.
    expect(await customerOutstanding(main.db, customer)).toBe(rupees(500))
    expect(await partyBalance(main.db, { type: 'customer', id: customer })).toBe(rupees(500))
    await expectSettled()
  })

  it('6 the last units sold on both counters', async () => {
    await sell(main, 9)
    await settle()
    await sell(c1, 1)
    await sell(c2, 1)
    await settle()
    expect(await shelf(main)).toBe(fromUnits(-1))
    await expectSettled(['sold_below_zero'])
  })

  it('7 credit on both counters past the limit', async () => {
    await sell(c1, 2, { credit: true })
    await sell(c2, 2, { credit: true })
    await settle()
    expect(await customerOutstanding(main.db, customer)).toBe(rupees(2000))
    await expectSettled(['over_credit_limit'])
  })

  it('8 a supplier paid the same bill on both counters', async () => {
    const supplier = await as(MAIN, () => createSupplier(main.db, { name: 'Mill', actorId: fx.adminId }))
    if (!supplier.ok) throw new Error('no supplier')
    await settle()
    for (const c of [c1, c2]) {
      await as(c.id, () => paySupplier(c.db, {
        supplierId: supplier.supplierId, amount: rupees(3000), method: 'cash',
        registerId: counterOf.get(c.id)!, actorId: fx.adminId,
      }))
    }
    await settle()
    expect(await supplierOwed(main.db, supplier.supplierId)).toBe(-rupees(6000))
    await expectSettled(['supplier_overpaid'])
    const over = (await findDiscrepancies(main.db)).find((d) => d.kind === 'supplier_overpaid')
    expect(over?.remedies?.map((r) => r.act)).toEqual(['cancel_payment', 'cancel_payment'])
    expect(await as(MAIN, () => applyRemedy(main.db, over!.remedies![1]!, fx.adminId))).toMatchObject({ ok: true })
    await settle()
    expect(await supplierOwed(main.db, supplier.supplierId), 'one payment left').toBe(-rupees(3000))
    await expectSettled()
  })

  it('9 one price changed differently on both counters', async () => {
    await as(C1, () => c1.db.execute(`UPDATE products SET base_rate = ? WHERE id = ?`, [rupees(550), product]))
    await as(C2, () => c2.db.execute(`UPDATE products SET base_rate = ? WHERE id = ?`, [rupees(450), product]))
    await settle()
    const rate = async (t: Till) => (await t.db.get<{ r: number }>(`SELECT base_rate AS r FROM products WHERE id = ?`, [product]))!.r
    const conflicts = await main.db.query(`SELECT table_name, winner, explain FROM sync_conflicts`)
    // One price, the same on every till, and the edit that lost is on record.
    const rates = new Set([await rate(main), await rate(c1), await rate(c2)])
    expect(rates.size).toBe(1)
    expect(conflicts.length).toBeGreaterThan(0)
    await expectSettled()
  })

  it('10 one customer changed differently on both counters', async () => {
    await as(C1, () => c1.db.execute(`UPDATE customers SET phone = '9000000001' WHERE id = ?`, [customer]))
    await as(C2, () => c2.db.execute(`UPDATE customers SET address = 'New street' WHERE id = ?`, [customer]))
    await settle()
    const row = await main.db.get(`SELECT phone, address FROM customers WHERE id = ?`, [customer])
    const conflicts = await main.db.query(`SELECT table_name, winner, explain FROM sync_conflicts`)
    expect(row).toBeDefined()
    expect(conflicts.length).toBeGreaterThan(0)
    await expectSettled()
  })

  it('11 the same loyalty points spent on both counters', async () => {
    await setSetting(main.db, 'loyalty_program', JSON.stringify({
      enabled: true, tiers: [{ minSpend: 0, pointsPerHundred: 5 }], expiryDays: 365, pointValue: 100,
      earnOnCreditPortion: false, minBillForEarn: 0, maxRedeemFractionBp: 10_000,
    }))
    await sell(main, 2) // ₹1000 at five points a hundred: 50 points
    await settle()
    const spent: string[] = []
    for (const c of [c1, c2]) {
      try { await sell(c, 1, { redeem: 50 }); spent.push(`${c.id.slice(0, 2)} spent 50`) } catch (e) { spent.push(`${c.id.slice(0, 2)} refused: ${String(e)}`) }
    }
    await settle()
    const points = await main.db.query(`SELECT points, consumed FROM loyalty_entries WHERE customer_id = ?`, [customer])
    expect(spent).toEqual(['22 spent 50', '33 spent 50'])
    void points
    await expectSettled(['points_spent_twice'])
  })

  it('12 one order billed on both counters', async () => {
    const order = await as(MAIN, async () => {
      const made = await createDocument(main.db, {
        kind: 'sales_order', registerId: fx.seed.registerId, customerId: customer,
        lines: [{ productId: product, qty: fromUnits(2) }], actorId: fx.adminId,
      })
      if (!made.ok) throw new Error(made.code)
      await submitDocument(main.db, { documentId: made.documentId, actorId: fx.adminId })
      return made.documentId
    })
    await settle()
    for (const c of [c1, c2]) {
      await as(c.id, async () => {
        const loaded = await documentToCart(c.db, { documentId: order })
        if (!loaded.ok) throw new Error(loaded.code)
        const d = await createBill(c.db, {
          registerId: counterOf.get(c.id)!, customerId: loaded.customerId, convertedFrom: loaded.documentId,
          lines: loaded.lines.map((l) => ({
            productId: l.productId, saleUnit: l.saleUnit, qty: l.qty,
            resolved: { rate: l.rate, source: 'order_rate' as const, sourceId: loaded.documentId },
          })),
          actorId: fx.adminId,
        })
        if (!d.ok) throw new Error(d.code)
        const paid = await submitBill(c.db, { billId: d.billId, payments: [{ method: 'cash', amount: d.grandTotal }], actorId: fx.adminId })
        if (!paid.ok) throw new Error(paid.code)
      })
    }
    await settle()
    await expectSettled(['order_billed_twice'])
    await putRight('order_billed_twice', 'cancel_bill')
  })

  it('13 one bill amended on both counters', async () => {
    const sale = await sell(main, 2)
    await settle()
    const made: string[] = []
    for (const c of [c1, c2]) {
      const r = await as(c.id, async () => {
        // The way the app amends: the bill is cancelled, then its copy is opened as a draft.
        await cancelBill(c.db, { billId: sale.billId, reason: 'amend', actorId: fx.adminId })
        const draft = await amendBill(c.db, { billId: sale.billId, registerId: counterOf.get(c.id)!, actorId: fx.adminId })
        if (!draft.ok) return draft.code
        const done = await submitBill(c.db, {
          billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
        })
        return done.ok ? `amended as ${done.docNo}` : done.code
      })
      made.push(`${c.id.slice(0, 2)} ${r}`)
    }
    await settle()
    const standing = await main.db.query(`SELECT doc_no, docstatus, amended_from FROM bills WHERE docstatus <> 0 ORDER BY created_at`)
    // Each correction took its own counter's number: two bills, neither lost.
    expect(made).toEqual([expect.stringMatching(/^22 amended as /), expect.stringMatching(/^33 amended as /)])
    expect(standing.filter((b) => (b as { docstatus: number }).docstatus === 1)).toHaveLength(2)
    await expectSettled(['corrected_twice'])
    await putRight('corrected_twice', 'cancel_bill')
  })

  it('14 one return cancelled on both counters', async () => {
    const sale = await sell(main, 1)
    const r = await as(MAIN, () => processReturn(main.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
    }))
    if (!r.ok) throw new Error(r.code)
    await settle()
    for (const c of [c1, c2]) await as(c.id, () => cancelReturn(c.db, { returnId: r.returnId, actorId: fx.adminId }))
    await settle()
    // Sold one, took it back, undid that -- once: nine.
    expect(await shelf(main)).toBe(fromUnits(9))
    await expectSettled()
  })

  it('15 one delivery cancelled on both counters', async () => {
    const entry = await as(MAIN, () => stockIn(main, 5))
    await settle()
    for (const c of [c1, c2]) await as(c.id, () => cancelStockEntry(c.db, { entryId: entry, actorId: fx.adminId }))
    await settle()
    // Five in and five out again -- once: back to ten.
    expect(await shelf(main)).toBe(fromUnits(10))
    await expectSettled()
  })

  it('16 an item switched off on one counter and sold on the other', async () => {
    await as(C1, () => setProductActive(c1.db, { actorId: fx.adminId } as never, product, false))
    await sell(c2, 1)
    await settle()
    const active = await main.db.get(`SELECT is_active FROM products WHERE id = ?`, [product])
    // The sale stands; the item stays off.
    expect(active).toEqual({ is_active: 0 })
    expect(await shelf(main)).toBe(fromUnits(9))
    await expectSettled()
  })

  it('17 a customer archived on one counter and sold to on credit on the other', async () => {
    const archived = await as(C1, () => archiveCustomer(c1.db, { actorId: fx.adminId } as never, customer))
    await sell(c2, 1, { credit: true })
    await settle()
    const row = await main.db.get(`SELECT is_active FROM customers WHERE id = ?`, [customer])
    expect(archived).toEqual({ ok: true })
    expect(await customerOutstanding(main.db, customer)).toBe(rupees(500))
    void row
    await expectSettled()
  })

  it('18 one advance spent on both counters', async () => {
    const paid = await as(MAIN, () => recordPayment(main.db, {
      customerId: customer, amount: rupees(1000), method: 'cash', registerId: fx.seed.registerId, actorId: fx.adminId,
    }))
    if (!paid.ok) throw new Error(paid.code)
    await settle()
    const used: unknown[] = []
    for (const c of [c1, c2]) {
      const bill = await sell(c, 2, { credit: true })
      used.push(await as(c.id, () => applyAdvance(c.db, { customerId: customer, billId: bill.billId, actorId: fx.adminId })))
    }
    await settle()
    // ₹1000 of advance cannot pay ₹2000 of bills: the books say what is still owed.
    expect(used).toHaveLength(2)
    expect(await partyBalance(main.db, { type: 'customer', id: customer })).toBe(rupees(1000))
    await expectSettled(['advance_spent_twice'])
  })

  it('19 part of one bill taken back on each counter', async () => {
    // Three sold. One back on each counter is two of three: nothing wrong.
    const sale = await sell(main, 3)
    await settle()
    const back = (c: Till, units: number) => as(c.id, () => processReturn(c.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(units) }], refundMethod: 'cash', actorId: fx.adminId,
    }))
    expect((await back(c1, 1)).ok).toBe(true)
    expect((await back(c2, 1)).ok).toBe(true)
    await settle()
    expect(await shelf(main)).toBe(fromUnits(9))
    const told = (await findDiscrepancies(main.db)).map((d) => d.kind)
    expect(told, 'two of three back is not a double refund').not.toContain('refunded_twice')
    await expectSettled()
  })

  it('19b more of one bill taken back across the counters than was sold', async () => {
    // Three sold; two back on each counter while apart is four of three.
    const sale = await sell(main, 3)
    await settle()
    for (const c of [c1, c2]) {
      const r = await as(c.id, () => processReturn(c.db, {
        billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(2) }], refundMethod: 'cash', actorId: fx.adminId,
      }))
      expect(r.ok).toBe(true)
    }
    await settle()
    await expectSettled(['refunded_twice'])
  })

  it('20 taken back on one counter, corrected on the other', async () => {
    const sale = await sell(main, 2)
    await settle()
    await as(C1, () => processReturn(c1.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(2) }], refundMethod: 'cash', actorId: fx.adminId,
    }))
    await as(C2, async () => {
      await cancelBill(c2.db, { billId: sale.billId, reason: 'amend', actorId: fx.adminId })
      const draft = await amendBill(c2.db, { billId: sale.billId, registerId: counterOf.get(C2)!, actorId: fx.adminId })
      if (!draft.ok) throw new Error(draft.code)
      const done = await submitBill(c2.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
      if (!done.ok) throw new Error(done.code)
    })
    await settle()
    // The correction cancelled the bill the return was taken against.
    await expectSettled(['refunded_and_cancelled'])
  })

  it('21 the same shelf counted on both counters', async () => {
    // Ten on the books, eight on the shelf: both counters find the two missing.
    for (const c of [c1, c2]) {
      await as(c.id, async () => {
        const opened = await openCount(c.db, { scope: { kind: 'chosen', productIds: [product] }, actorId: fx.adminId })
        if (!opened.ok) throw new Error(opened.code)
        await setCounted(c.db, { countId: opened.countId, productId: product, countedQty: fromUnits(8) })
        const done = await submitCount(c.db, { countId: opened.countId, actorId: fx.adminId })
        if (!done.ok) throw new Error(done.code)
      })
    }
    await settle()
    // Each took its own two off: the stock says six, the shelf holds eight -- and the shop is told to count again.
    expect(await shelf(main)).toBe(fromUnits(6))
    await expectSettled(['counted_twice'])

    // The recount it is told to make puts the stock right, and the warning is not raised again by it.
    await as(MAIN, async () => {
      const opened = await openCount(main.db, { scope: { kind: 'chosen', productIds: [product] }, actorId: fx.adminId })
      if (!opened.ok) throw new Error(opened.code)
      await setCounted(main.db, { countId: opened.countId, productId: product, countedQty: fromUnits(8) })
      const done = await submitCount(main.db, { countId: opened.countId, actorId: fx.adminId })
      if (!done.ok) throw new Error(done.code)
    })
    await settle()
    expect(await shelf(main)).toBe(fromUnits(8))
    for (const t of [main, c1, c2]) {
      expect((await findDiscrepancies(t.db)).map((d) => d.kind)).not.toContain('counted_twice')
    }
    await expectSettled()
  })

  it('21b one shelf counted twice on one till, one after the other, is not a double count', async () => {
    for (const found of [8, 7]) {
      await as(C1, async () => {
        const opened = await openCount(c1.db, { scope: { kind: 'chosen', productIds: [product] }, actorId: fx.adminId })
        if (!opened.ok) throw new Error(opened.code)
        await setCounted(c1.db, { countId: opened.countId, productId: product, countedQty: fromUnits(found) })
        const done = await submitCount(c1.db, { countId: opened.countId, actorId: fx.adminId })
        if (!done.ok) throw new Error(done.code)
      })
    }
    await settle()
    expect(await shelf(main)).toBe(fromUnits(7))
    expect((await findDiscrepancies(main.db)).map((d) => d.kind)).not.toContain('counted_twice')
    await expectSettled()
  })

  it('22 the main acts too, while the counters cannot reach it', async () => {
    // The main is up but both counters are cut off from it: three tills apart, not two.
    const sale = await sell(main, 1)
    await settle()
    await as(MAIN, () => cancelBill(main.db, { billId: sale.billId, reason: 'main', actorId: fx.adminId }))
    for (const c of [c1, c2]) {
      await as(c.id, () => processReturn(c.db, {
        billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
      }))
    }
    await settle()
    await expectSettled(['refunded_twice', 'refunded_and_cancelled'])
  })

  it('23 the counters come back one at a time, with the main busy in between', async () => {
    const rate = async (t: Till) => (await t.db.get<{ r: number }>(`SELECT base_rate AS r FROM products WHERE id = ?`, [product]))!.r
    await as(C1, () => c1.db.execute(`UPDATE products SET base_rate = ?, updated_at = ? WHERE id = ?`, [rupees(550), '2026-10-15T10:00:00.000Z', product]))
    await as(C2, () => c2.db.execute(`UPDATE products SET base_rate = ?, updated_at = ? WHERE id = ?`, [rupees(450), '2026-10-15T10:05:00.000Z', product]))
    await sell(c1, 1)
    await sell(c2, 1)

    // The first counter back; the main sells and changes the price again meanwhile.
    await pull(c1, main)
    await sell(main, 1)
    await as(MAIN, () => main.db.execute(`UPDATE products SET base_rate = ?, updated_at = ? WHERE id = ?`, [rupees(600), '2026-10-15T10:10:00.000Z', product]))
    await pull(c1, main)
    // Only now the second.
    await pull(c2, main)
    await settle()

    // The last change wins everywhere, and every sale is on every till.
    for (const t of [main, c1, c2]) expect(await rate(t)).toBe(rupees(600))
    expect(await shelf(main)).toBe(fromUnits(7))
    await expectSettled()
  })

  it('24 a bill made from an order, cancelled on another till, is cancelled on every till', async () => {
    /* Not a thing done twice: one cancel. Cancelling deleted the bill's record
       of what it took from the order, which is a line of a submitted bill, and
       every other till refused the change -- so the bill stood everywhere but
       the till that cancelled it, and the order stayed billed. */
    const order = await as(MAIN, async () => {
      const made = await createDocument(main.db, {
        kind: 'sales_order', registerId: fx.seed.registerId, customerId: customer,
        lines: [{ productId: product, qty: fromUnits(2) }], actorId: fx.adminId,
      })
      if (!made.ok) throw new Error(made.code)
      await submitDocument(main.db, { documentId: made.documentId, actorId: fx.adminId })
      return made.documentId
    })
    const billId = await as(MAIN, async () => {
      const loaded = await documentToCart(main.db, { documentId: order })
      if (!loaded.ok) throw new Error(loaded.code)
      const d = await createBill(main.db, {
        registerId: fx.seed.registerId, customerId: loaded.customerId, convertedFrom: loaded.documentId,
        lines: loaded.lines.map((l) => ({
          productId: l.productId, saleUnit: l.saleUnit, qty: l.qty,
          resolved: { rate: l.rate, source: 'order_rate' as const, sourceId: loaded.documentId },
        })),
        actorId: fx.adminId,
      })
      if (!d.ok) throw new Error(d.code)
      const paid = await submitBill(main.db, { billId: d.billId, payments: [{ method: 'cash', amount: d.grandTotal }], actorId: fx.adminId })
      if (!paid.ok) throw new Error(paid.code)
      return d.billId
    })
    await settle()

    expect(await as(C1, () => cancelBill(c1.db, { billId, reason: 'wrong', actorId: fx.adminId }))).toMatchObject({ ok: true })
    await settle()

    for (const t of [main, c1, c2]) {
      const bill = await t.db.get<{ docstatus: number }>(`SELECT docstatus FROM bills WHERE id = ?`, [billId])
      expect(bill?.docstatus, `${t.id.slice(0, 2)} holds it cancelled`).toBe(2)
      const line = await t.db.get<{ f: number }>(`SELECT fulfilled_qty AS f FROM document_items WHERE document_id = ?`, [order])
      expect(line?.f, `${t.id.slice(0, 2)}: the order is open again`).toBe(0)
    }
    expect(await shelf(main)).toBe(fromUnits(10))
    await expectSettled()
  })
})
