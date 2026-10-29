import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setProductActive } from '../src/services/products.js'
import { searchProducts, searchCustomers, loadCustomer } from '../src/repos/catalog.js'
import { createCustomer, archiveCustomer, restoreCustomer } from '../src/services/customers.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { recordPayment } from '../src/services/payments.js'
import { topProducts } from '../src/repos/reports.js'
import { postMovement } from '../src/services/stock.js'
import { newId } from '../src/ids.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Taking a product out of use without taking it out of history.
 *
 * `products.is_active` has been in the schema since 001 and read since the
 * catalogue was written — the counter's search filters on it, the reorder
 * report filters on it. Nothing ever set it to 0. The column worked perfectly
 * and no shop could reach it, so what a shop did instead was rename the thing
 * to "OLD - do not use", which is worse in every way the column was meant to
 * prevent.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ALL = { from: '0000-01-01', to: '9999-12-31' }

describe('a product taken out of use', () => {
  it('stops appearing where a live product belongs', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ink Ribbon' })
    expect((await searchProducts(fx.db, { term: 'Ribbon' })).map((p) => p.id)).toEqual([productId])

    await setProductActive(fx.db, { actorId: fx.adminId }, productId, false)

    // The counter's search, which is the one that matters at the till.
    expect(await searchProducts(fx.db, { term: 'Ribbon' })).toEqual([])
  })

  it('is still findable on the screen that can bring it back', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ink Ribbon' })
    await setProductActive(fx.db, { actorId: fx.adminId }, productId, false)

    /* Retired and invisible everywhere would be retired and unrecoverable. The
       inventory screen asks for them and is told which they are. */
    const rows = await searchProducts(fx.db, { term: 'Ribbon', includeInactive: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.isActive).toBe(false)
  })

  it('comes back', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ink Ribbon' })
    await setProductActive(fx.db, { actorId: fx.adminId }, productId, false)
    await setProductActive(fx.db, { actorId: fx.adminId }, productId, true)

    expect((await searchProducts(fx.db, { term: 'Ribbon' })).map((p) => p.id)).toEqual([productId])
  })

  it('keeps every sale it was ever part of', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ink Ribbon', baseRate: rupees(200) })
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      postingDate: '2026-03-01',
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
    })

    await setProductActive(fx.db, { actorId: fx.adminId }, productId, false)

    /* A product that has been sold can never be deleted — every `bill_items`
       row names it, and the margin report, the stock ledger and the return path
       all still join to it. Retiring is what a shop needs and deleting is what
       would leave it with bills it cannot explain. */
    const sold = await topProducts(fx.db, ALL)
    expect(sold.map((p) => p.name)).toContain('Ink Ribbon')
  })

  it('keeps the stock that is still on the shelf', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ink Ribbon' })
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId,
        qtyChange: fromUnits(6),
        unitCost: rupees(100),
        voucherType: 'opening',
        voucherId: newId(),
        postingDate: '2026-03-01',
      })
    })

    await setProductActive(fx.db, { actorId: fx.adminId }, productId, false)

    // The goods are still on the shelf until somebody says otherwise, and the
    // valuation of the shop has not changed because a button was pressed.
    const row = await fx.db.get<{ qty: number }>(
      `SELECT qty_on_hand AS qty FROM product_stock WHERE product_id = ?`, [productId])
    expect(row?.qty).toBe(fromUnits(6))
  })

  it('writes who did it, in words a person can read', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ink Ribbon' })
    await setProductActive(fx.db, { actorId: fx.adminId }, productId, false)

    const audit = await fx.db.get<{ actor_id: string; diff: string }>(
      `SELECT actor_id, diff FROM audit_log WHERE entity = 'products' AND entity_id = ?`,
      [productId],
    )
    expect(audit?.actor_id).toBe(fx.adminId)
    expect(audit?.diff).toContain('retired')
  })

  it('does nothing at all when it is already in that state', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ink Ribbon' })
    await setProductActive(fx.db, { actorId: fx.adminId }, productId, true)

    /* No row, no `rev` bump, nothing to sync. A screen that re-sends the state
       it already has must not manufacture a change for the other till to
       resolve. */
    const rows = await fx.db.query(
      `SELECT id FROM audit_log WHERE entity = 'products' AND entity_id = ?`, [productId])
    expect(rows).toEqual([])
  })
})

describe('a customer who has stopped coming', () => {
  async function customer(name: string): Promise<string> {
    const made = await createCustomer(fx.db, { actorId: fx.adminId }, { name, creditEnforcement: 'none' })
    if (!made.ok) throw new Error(`could not create: ${made.code}`)
    return made.customerId
  }

  it('goes out of every search, including the counter_s', async () => {
    const id = await customer('Walk-in Ravi')
    expect((await searchCustomers(fx.db, 'Ravi')).map((c) => c.id)).toEqual([id])

    expect(await archiveCustomer(fx.db, { actorId: fx.adminId }, id)).toEqual({ ok: true })
    expect(await searchCustomers(fx.db, 'Ravi')).toEqual([])
  })

  it('is still there for the screen that can bring them back', async () => {
    const id = await customer('Walk-in Ravi')
    await archiveCustomer(fx.db, { actorId: fx.adminId }, id)

    const rows = await searchCustomers(fx.db, 'Ravi', 50, { includeArchived: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.archived).toBe(true)

    await restoreCustomer(fx.db, { actorId: fx.adminId }, id)
    expect((await searchCustomers(fx.db, 'Ravi')).map((c) => c.id)).toEqual([id])
  })

  it('can still be opened, so an old bill still says who it was for', async () => {
    const id = await customer('Walk-in Ravi')
    await archiveCustomer(fx.db, { actorId: fx.adminId }, id)

    const loaded = await loadCustomer(fx.db, id)
    expect(loaded?.name).toBe('Walk-in Ravi')
    expect(loaded?.archived).toBe(true)
  })

  it('refuses while they still owe money', async () => {
    const id = await customer('Sri Vidya School')
    const productId = await makeProduct(fx.db, { name: 'Chalk', baseRate: rupees(500) })

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId: id,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId, actorId: fx.adminId,
      payments: [{ method: 'credit', amount: draft.grandTotal }],
    })

    /* Archiving hides them from every search, so a balance nobody can find is a
       debt the shop has written off without deciding to. */
    const result = await archiveCustomer(fx.db, { actorId: fx.adminId }, id)
    expect(result).toEqual({ ok: false, code: 'OWES_MONEY', outstanding: rupees(500) })

    // And they are still there, which is the point of refusing.
    expect(await searchCustomers(fx.db, 'Vidya')).toHaveLength(1)
  })

  it('allows it once the khata is settled by a receipt', async () => {
    /* The other half of the sum. A bill taken on credit and later paid off with
       a payment entry leaves `bills.credit_total` exactly where it was -- what
       cancels it is the allocation -- so a balance that only added up the bills
       would refuse this customer for ever. */
    const id = await customer('Sri Vidya School')
    const productId = await makeProduct(fx.db, { name: 'Chalk', baseRate: rupees(500) })

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId: id,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId, actorId: fx.adminId,
      payments: [{ method: 'credit', amount: draft.grandTotal }],
    })

    expect(await archiveCustomer(fx.db, { actorId: fx.adminId }, id))
      .toMatchObject({ ok: false, code: 'OWES_MONEY' })

    const paid = await recordPayment(fx.db, {
      customerId: id, amount: draft.grandTotal, method: 'cash', actorId: fx.adminId,
    })
    if (!paid.ok) throw new Error(paid.code)

    expect(await archiveCustomer(fx.db, { actorId: fx.adminId }, id)).toEqual({ ok: true })
  })

  it('allows it once the khata is settled', async () => {
    const id = await customer('Sri Vidya School')
    const productId = await makeProduct(fx.db, { name: 'Chalk', baseRate: rupees(500) })

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId: id,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
    })

    // Paid at the counter, so nothing is owed and nothing is hidden.
    expect(await archiveCustomer(fx.db, { actorId: fx.adminId }, id)).toEqual({ ok: true })
  })
})
