#!/usr/bin/env node
/** Bills a few days of plausible trade so the reporting screens have something real in them. */
import { openDatabase } from '../src/db/node-driver.ts'
import { createBill, submitBill } from '../src/services/billing.ts'
import { createReturn, submitReturn } from '../src/services/returns.ts'
import { recordPayment } from '../src/services/payments.ts'
import { getOrOpenSession } from '../src/services/cash.ts'
import { fromUnits } from '../src/quantity.ts'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const db = openDatabase(arg('db'))

const admin = await db.get(`SELECT id FROM users WHERE username = 'admin'`)
const register = await db.get(`SELECT id FROM registers LIMIT 1`)
const products = await db.query(`SELECT id, name FROM products ORDER BY rowid`)
const customers = await db.query(`SELECT id, name FROM customers WHERE name <> 'Walk-in' ORDER BY rowid`)

await getOrOpenSession(db, { registerId: register.id, userId: admin.id, openingCash: 200_000 })

const today = new Date()
const day = (back) => {
  const d = new Date(today)
  d.setDate(d.getDate() - back)
  return d.toISOString().slice(0, 10)
}

let made = 0
let firstBill = null

for (let i = 0; i < 22; i++) {
  const daysBack = i < 14 ? 0 : i < 18 ? 1 : 2
  const onCredit = i % 6 === 0
  const customer = onCredit || i % 3 === 0 ? customers[i % customers.length] : null

  const picks = [products[i % products.length], products[(i * 7 + 3) % products.length]]
  const lines = picks.map((p, n) => ({ productId: p.id, qty: fromUnits(1 + ((i + n) % 4)) }))

  const draft = await createBill(db, {
    registerId: register.id,
    customerId: customer?.id ?? null,
    lines,
    postingDate: day(daysBack),
    actorId: admin.id,
  })
  if (!draft.ok) { console.warn(`skipped: ${draft.code}`); continue }

  const method = onCredit && customer ? 'credit' : i % 4 === 0 ? 'upi' : 'cash'
  const result = await submitBill(db, {
    billId: draft.billId,
    payments: [{ method, amount: draft.grandTotal }],
    actorId: admin.id,
  })
  if (!result.ok) { console.warn(`skipped: ${result.code}`); continue }

  made++
  firstBill ??= draft.billId
}

// One partial return, so a credit note and a partially-returned line both exist.
if (firstBill) {
  const item = await db.get(`SELECT id FROM bill_items WHERE bill_id = ? LIMIT 1`, [firstBill])
  const ret = await createReturn(db, {
    billId: firstBill,
    lines: [{ billItemId: item.id, qty: fromUnits(1) }],
    refundMethod: 'cash',
    reason: 'Customer changed their mind',
    actorId: admin.id,
  })
  if (ret.ok) await submitReturn(db, { returnId: ret.returnId, actorId: admin.id })
}

// And one receipt against the oldest credit bill.
const owing = customers[0]
if (owing) {
  await recordPayment(db, {
    customerId: owing.id,
    amount: 50_000,
    method: 'cash',
    registerId: register.id,
    actorId: admin.id,
  })
}

console.log(`billed ${made} sales, 1 return, 1 receipt`)
await db.close()
