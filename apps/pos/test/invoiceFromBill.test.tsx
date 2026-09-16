import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  migrate, bootstrap, newId,
  createBill, submitBill, setSetting,
  type SqlDriver, type BootstrapResult,
} from '@shopos/core'
/* Not through `@shopos/core`, which deliberately does not export it: the node
   driver must never be reachable from the webview, and the app's own build
   aliases `better-sqlite3` to an empty module so that a stray import fails at
   build time rather than confusingly at run time. A test is the one caller
   that is allowed to reach around it. */
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { sheetDocFor } from '../src/core/printHtml'

/**
 * The invoice a real bill produces, not the one a hand-built fixture does.
 *
 * `invoiceHtml.ts` has been tested against a document assembled in a test file
 * since it was written, and every one of those tests passed while the app was
 * handing it the *shop's* own state as the place of supply on every invoice —
 * including the ones billed to another state and charged IGST. The renderer was
 * never wrong. The thing that filled it in was.
 *
 * So this goes the other way round: a bill is rung up through the real service,
 * submitted through the real service, and the document handed to the renderer is
 * whatever `sheetDocFor` actually builds from it.
 */

let db: SqlDriver
let seed: BootstrapResult
let adminId: string

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
  await setSetting(db, 'shop_state_code', '33')
})

afterEach(async () => { await db.close() })

async function product(name: string, paise: number, rateBp = 1800): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, hsn_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, '4802', ?, ?)`,
    [id, name, paise, rateBp, now, now],
  )
  return id
}

async function customer(name: string, state: string, gstin: string | null): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO customers (id, name, address, state_code, gstin, created_at, updated_at)
     VALUES (?, ?, '9 School Road, Perambalur 621212', ?, ?, ?, ?)`,
    [id, name, state, gstin, now, now],
  )
  return id
}

async function billed(customerId: string | null, productId: string): Promise<string> {
  const draft = await createBill(db, {
    registerId: seed.registerId,
    ...(customerId ? { customerId } : {}),
    lines: [{ productId, qty: 10_000 as never }],
    actorId: adminId,
  })
  if (!draft.ok) throw new Error('draft failed')

  const done = await submitBill(db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: adminId,
  })
  if (!done.ok) throw new Error(`submit failed: ${done.code}`)
  return draft.billId
}

describe('the sheet built from a bill that was actually rung up', () => {
  it('takes the place of supply from the bill, not from the shop', async () => {
    const buyer = await customer('Ramesh Traders', '27', '27AABCR5678G1Z2')
    const doc = await sheetDocFor(db, await billed(buyer, await product('Paper', 34_000)))

    /* The whole point. The shop is in 33 and this invoice is billed to 27, and
       the old code printed "Tamil Nadu" on it. */
    expect(doc?.placeOfSupply).toEqual({ code: '27', name: 'Maharashtra' })
    expect(doc?.supplyType).toBe('inter_state')
    expect(doc?.igst).toBeGreaterThan(0)
    expect(doc?.cgst).toBe(0)
  })

  it('carries the recipient the bill was issued to, address and GSTIN', async () => {
    const buyer = await customer('Sri Vidya School', '33', '33AAACS1234F1Z5')
    const doc = await sheetDocFor(db, await billed(buyer, await product('Paper', 34_000)))

    expect(doc?.customerName).toBe('Sri Vidya School')
    expect(doc?.customerAddress).toBe('9 School Road, Perambalur 621212')
    expect(doc?.customerGstin).toBe('33AAACS1234F1Z5')
    expect(doc?.customerState).toEqual({ code: '33', name: 'Tamil Nadu' })
  })

  it('keeps saying what it said after the customer record moves on', async () => {
    const buyer = await customer('Sri Vidya School', '33', '33AAACS1234F1Z5')
    const billId = await billed(buyer, await product('Paper', 34_000))

    await db.execute(
      `UPDATE customers SET gstin = '27AABCR5678G1Z2', address = 'Somewhere else' WHERE id = ?`,
      [buyer],
    )

    /* A reprint has to match the copy in the customer's hand. Read through a
       live join, this was the sentence that rewrote every invoice ever issued
       to a customer who corrected their registration. */
    const doc = await sheetDocFor(db, billId)
    expect(doc?.customerGstin).toBe('33AAACS1234F1Z5')
    expect(doc?.customerAddress).toBe('9 School Road, Perambalur 621212')
  })

  it('says nothing about the place of supply for a walk-in', async () => {
    const doc = await sheetDocFor(db, await billed(null, await product('Paper', 34_000)))

    expect(doc?.customerName).toBeNull()
    expect(doc?.placeOfSupply).toBeNull()
    // Still a local sale, and still charged as one.
    expect(doc?.supplyType).toBe('intra_state')
    expect(doc?.cgst).toBeGreaterThan(0)
  })

  it('carries the rate on every line and a summary rate by rate', async () => {
    const buyer = await customer('Sri Vidya School', '33', '33AAACS1234F1Z5')
    const five = await product('Notebook', 10_500, 500)

    const draft = await createBill(db, {
      registerId: seed.registerId,
      customerId: buyer,
      lines: [
        { productId: await product('Paper', 34_000), qty: 10_000 as never },
        { productId: five, qty: 10_000 as never },
      ],
      actorId: adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: adminId,
    })

    const doc = await sheetDocFor(db, draft.billId)
    expect(doc?.items.map((i) => i.taxRateBp)).toEqual([1800, 500])

    // Sorted by rate, one row each, and summing back to the bill.
    const rates = doc?.rateSummary ?? []
    expect(rates.map((r) => r.rateBp)).toEqual([500, 1800])
    expect(rates.reduce((s, r) => s + r.taxable, 0)).toBe(doc?.taxableTotal)
    expect(rates.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0))
      .toBe((doc?.cgst ?? 0) + (doc?.sgst ?? 0) + (doc?.igst ?? 0))
  })

  it('says the tax is not payable on reverse charge, rather than leaving it open', async () => {
    const doc = await sheetDocFor(db, await billed(null, await product('Paper', 34_000)))
    // Rule 46(p). False, always, in this product — and said.
    expect(doc?.reverseCharge).toBe(false)
  })
})
