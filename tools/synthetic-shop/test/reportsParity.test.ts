import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemoryDatabase } from '@shopos/core/node'
import { migrate, processReturn, type SqlDriver } from '@shopos/core'
import { MIGRATIONS } from '@shopos/core/migrations'
import {
  salesSummary, salesByDay, topProducts, paymentMix, taxByRate, salesByStaff,
  gstLines, gstExceptions, grossMargin, marginByProduct,
} from '../../../packages/core/src/repos/reports.js'
import { buildSyntheticShop } from '../src/build.js'

/**
 * Every report, on a year of a real-sized shop, against a recorded answer.
 *
 * Written to move `reports.ts` onto typed queries without taking anybody's word
 * for it. These ten functions are what a shopkeeper files a GST return from and
 * what an owner judges a year by, and the failure mode of a rewrite here is not
 * an error — it is a number that is quietly different. A suite of small
 * fixtures cannot see that: three bills and one return exercise none of the
 * grouping, none of the credit notes, and none of the rounding.
 *
 * So: the synthetic shop, which is deterministic from its seed — 20,000 bills,
 * 400 products, 600 customers, a year, with cancellations in it — plus twenty
 * returns taken here, and the ten answers written down beside this file. If a
 * rewrite changes any figure, this says which one and by how much.
 *
 * ## What is written down, and why it is not the answers themselves
 *
 * The GST export of a year of this shop is thirty thousand rows and thirteen
 * megabytes of JSON, which is not a file to keep in a repository and not a diff
 * anybody can read. So each report is recorded as a digest of its whole answer,
 * with its row count and its first and last three rows in the clear. The digest
 * is what catches a change anywhere in the middle; the count and the ends are
 * what make the failure legible when it does.
 *
 * ## Re-recording
 *
 * `npm test -- -u` is not enough on purpose; the file is written only when it
 * is absent, so a changed answer is a failure and never a silent update. If a
 * report is *meant* to change, delete the snapshot in the same commit that
 * changes it, and the diff will show the new figures going in.
 */

/* `fileURLToPath`, not `pathname.slice(1)`: the slice turns `/C:/...` into a
   Windows path and turns `/home/...` into a relative one, so on Linux the file
   was written under the working directory and never compared against. */
const RECORDED = join(dirname(fileURLToPath(import.meta.url)), 'reports-recorded.json')

/** The whole generated year, so nothing is excluded by the range. */
const RANGE = { from: '2025-09-01', to: '2026-09-30' }

let db: SqlDriver
let answers: Record<string, unknown>

/**
 * Twenty returns, taken against the earliest bills the generator made.
 *
 * The generator does not make any -- a shop of 20,000 bills and no returns is
 * not a shop, and that is worth fixing in the generator rather than here, in a
 * commit that can re-record every figure it moves. Until then the credit-note
 * half of the GST export would be snapshotted as an empty list, which would
 * hold nothing: a rewrite that dropped the UNION entirely would still pass.
 *
 * Deterministic: the oldest twenty submitted bills by document number, one line
 * off each, refunded in cash.
 */
async function takeSomeReturns(): Promise<number> {
  const bills = await db.query<{ id: string; created_by: string }>(
    `SELECT b.id, b.created_by FROM bills b
      WHERE b.docstatus = 1 AND b.kind = 'sale'
      ORDER BY b.doc_no LIMIT 20`,
  )

  let taken = 0
  for (const bill of bills) {
    const [line] = await db.query<{ id: string; qty: number }>(
      `SELECT id, qty FROM bill_items WHERE bill_id = ? ORDER BY idx LIMIT 1`,
      [bill.id],
    )
    if (!line) continue

    const done = await processReturn(db, {
      billId: bill.id,
      lines: [{ billItemId: line.id, qty: line.qty as never }],
      refundMethod: 'cash',
      actorId: bill.created_by,
      now: new Date('2026-09-20T11:00:00+05:30'),
    })
    if (done.ok) taken += 1
  }
  return taken
}

beforeAll(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  await buildSyntheticShop(db)
  const returns = await takeSomeReturns()
  if (returns === 0) throw new Error('no returns were taken; the export would prove nothing')

  answers = {
    salesSummary: await salesSummary(db, RANGE),
    salesByDay: await salesByDay(db, RANGE),
    topProducts: await topProducts(db, RANGE, 20),
    paymentMix: await paymentMix(db, RANGE),
    taxByRate: await taxByRate(db, RANGE),
    salesByStaff: await salesByStaff(db, RANGE),
    gstLines: await gstLines(db, RANGE),
    gstExceptions: await gstExceptions(db, RANGE),
    grossMargin: await grossMargin(db, RANGE),
    marginByProduct: await marginByProduct(db, RANGE, 25),
  }
}, 180_000)

/** What `newId()` makes: random per run, and in half of these reports. */
const GENERATED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The same answer with its identifiers blanked.
 *
 * The shop is deterministic from its seed in every figure it holds, but the
 * primary keys are not: `newId()` is random, so a product id differs on every
 * build and `topProducts` hashed to something new each run. Three runs gave
 * three hashes before this was here, which is a snapshot that fails for a
 * reason nobody can act on and gets deleted within a week.
 *
 * What must not move is the arithmetic -- the names, the dates, the document
 * numbers and the money. Those are all seeded. So the ids come out and
 * everything else stays exactly as it is, including their *position*, because a
 * report that returned its rows in a different order would still be caught.
 */
function withoutIds(value: unknown): unknown {
  if (typeof value === 'string') return GENERATED_ID.test(value) ? '<id>' : value
  if (Array.isArray(value)) return value.map(withoutIds)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withoutIds(v)]),
    )
  }
  return value
}

/**
 * A report as a line that fits in a file: a digest of all of it, plus enough in
 * the clear to read a failure.
 */
function digestOf(raw: unknown): unknown {
  const value = withoutIds(raw)
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
  if (!Array.isArray(value)) return { hash, value }
  return {
    hash,
    rows: value.length,
    first: value.slice(0, 3),
    last: value.slice(-3),
  }
}

describe('every report, against the answer it gave before', () => {
  it('has something to compare, and it is not empty', () => {
    /* A snapshot of ten empty arrays would pass every assertion below for ever
       while saying nothing about the code. */
    const summary = answers['salesSummary'] as { bills: number; total: number }
    expect(summary.bills).toBeGreaterThan(10_000)
    expect(summary.total).toBeGreaterThan(0)
    expect((answers['gstLines'] as unknown[]).length).toBeGreaterThan(1_000)
    expect((answers['taxByRate'] as unknown[]).length).toBeGreaterThan(1)
  })

  it('agrees with it, figure for figure', () => {
    const now = Object.fromEntries(
      Object.entries(answers).map(([name, value]) => [name, digestOf(value)]),
    )

    if (!existsSync(RECORDED)) {
      mkdirSync(dirname(RECORDED), { recursive: true })
      writeFileSync(RECORDED, `${JSON.stringify(now, null, 2)}\n`)
      console.log(`recorded ${RECORDED}`)
      return
    }

    const recorded = JSON.parse(readFileSync(RECORDED, 'utf8')) as Record<string, unknown>

    /* Compared one report at a time rather than as one object: a whole-file
       mismatch prints ten reports of diff and the one that moved is somewhere
       in the middle of it. */
    for (const name of Object.keys(now)) {
      expect(now[name], `${name} changed`).toEqual(recorded[name])
    }
  })
})

describe('the credit notes in the GST export', () => {
  it('are there, negative, and named against the invoice they reverse', () => {
    /* The thing the export exists for, checked directly rather than only
       through the snapshot: a rewrite that dropped the UNION would leave a
       perfectly consistent file of invoices and over-declare the shop's output
       tax by every rupee it refunded. */
    const lines = answers['gstLines'] as {
      kind: string; againstDocNo: string | null; taxable: number
    }[]
    const notes = lines.filter((l) => l.kind === 'credit_note')

    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((n) => n.taxable <= 0)).toBe(true)
    expect(notes.every((n) => n.againstDocNo !== null)).toBe(true)
  })

  it('pull the rate summary down by exactly what they credit', () => {
    const lines = answers['gstLines'] as { kind: string; rateBp: number; taxable: number }[]
    const rates = answers['taxByRate'] as { rateBp: number; taxable: number }[]

    for (const rate of rates) {
      const fromLines = lines
        .filter((l) => l.rateBp === rate.rateBp)
        .reduce((sum, l) => sum + l.taxable, 0)
      expect(fromLines, `rate ${rate.rateBp}`).toBe(rate.taxable)
    }
  })
})
