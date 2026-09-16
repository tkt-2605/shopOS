import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openDatabase } from '../src/db/node-driver.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { salesSummary, taxByRate, gstLines } from '../src/repos/reports.js'
import { loadTaxScheme, taxSchemeAnswered } from '../src/services/features.js'
import { getSetting } from '../src/services/bootstrap.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * The GST export, run over a shop that has been trading.
 *
 * The fixture that ships with this repo has been shown to lie twice: it had no
 * row that could tell CGST from SGST when they disagreed, and none that could
 * tell a fabricated state code from a real one. The rule that came out of it is
 * that a claim about money is checked against the owner's own database before
 * anybody believes it.
 *
 * What is asserted here is what the phase checklist asks for in words: that the
 * sales summary is untouched by this work, that the rate rows now tie to the
 * grand totals to the paisa, and that the returns the shop has actually taken
 * are in the export and are negative.
 *
 * Skipped when the fixture is absent, which is the normal state — it is
 * gitignored real trade and CI has never seen it. `npm run pull-shop-db`
 * creates it. A skip is not a pass.
 */

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', '..', 'tools', 'fixtures', 'real-shop.db')
const MIGRATIONS_DIR = join(here, '..', 'migrations')

const present = existsSync(FIXTURE)

/** Everything the shop has ever billed, so no row can hide outside the range. */
const ALL = { from: '0000-01-01', to: '9999-12-31' }

function migratedCopy(): { db: SqlDriver; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shopos-reports-'))
  const path = join(dir, 'shop.db')
  copyFileSync(FIXTURE, path)

  const raw = new Database(path)
  const from = raw.pragma('user_version', { simple: true }) as number
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    raw.exec('BEGIN')
    raw.exec(readFileSync(join(MIGRATIONS_DIR, m.name), 'utf8'))
    raw.exec(`PRAGMA user_version = ${m.version}`)
    raw.exec('COMMIT')
  }
  raw.close()

  return { db: openDatabase(path), dir }
}

async function withShop<T>(fn: (db: SqlDriver) => Promise<T>): Promise<T> {
  const { db, dir } = migratedCopy()
  try {
    return await fn(db)
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!present)('the GST export over the real shop', () => {
  it('leaves the sales summary exactly as it was', async () => {
    await withShop(async (db) => {
      const summary = await salesSummary(db, ALL)
      const raw = await db.get<{ n: number; total: number; refunds: number }>(
        `SELECT (SELECT COUNT(*) FROM bills WHERE docstatus = 1 AND kind = 'sale') AS n,
                (SELECT COALESCE(SUM(grand_total), 0) FROM bills
                  WHERE docstatus = 1 AND kind = 'sale') AS total,
                (SELECT COALESCE(SUM(refund_total), 0) FROM sales_returns
                  WHERE docstatus = 1) AS refunds`,
      )

      /* None of this work touched `salesSummary`, and the checklist says to
         prove it rather than assume it: this is the figure the owner reads off
         the dashboard every evening. */
      expect(summary.bills).toBe(raw!.n)
      expect(summary.total).toBe(raw!.total)
      expect(summary.returns).toBe(raw!.refunds)
      expect(summary.net).toBe(raw!.total - raw!.refunds)
    })
  })

  it('has a row for every submitted bill and no row for anything else', async () => {
    await withShop(async (db) => {
      const lines = await gstLines(db, ALL)
      const invoices = new Set(lines.filter((l) => l.kind === 'invoice').map((l) => l.docNo))

      const billed = await db.query<{ doc_no: string }>(
        `SELECT doc_no FROM bills WHERE docstatus = 1 AND kind = 'sale'`)
      expect(invoices.size).toBe(billed.length)
      for (const b of billed) expect(invoices.has(b.doc_no), b.doc_no).toBe(true)

      // A cancelled bill was never filed, so there is nothing to reverse and
      // nothing to declare.
      const cancelled = await db.query<{ doc_no: string }>(
        `SELECT doc_no FROM bills WHERE docstatus = 2`)
      for (const c of cancelled) expect(invoices.has(c.doc_no), c.doc_no).toBe(false)
    })
  })

  it('ties every bill to its own grand total, to the paisa', async () => {
    await withShop(async (db) => {
      const lines = await gstLines(db, ALL)

      const byInvoice = new Map<string, number>()
      for (const l of lines) {
        if (l.kind !== 'invoice') continue
        byInvoice.set(l.docNo, (byInvoice.get(l.docNo) ?? 0) + l.total)
      }

      const bills = await db.query<{ doc_no: string; grand_total: number }>(
        `SELECT doc_no, grand_total FROM bills WHERE docstatus = 1 AND kind = 'sale'`)

      /* The whole reason `round_off` had to land on a rate row. A CA adding the
         export up against the invoices is now out by nothing at all. */
      for (const b of bills) {
        expect(byInvoice.get(b.doc_no), b.doc_no).toBe(b.grand_total)
      }
    })
  })

  it('declares the returns the shop actually took, negative', async () => {
    await withShop(async (db) => {
      const filed = await db.query<{ doc_no: string; refund_total: number }>(
        `SELECT doc_no, refund_total FROM sales_returns WHERE docstatus = 1`)

      const notes = (await gstLines(db, ALL)).filter((l) => l.kind === 'credit_note')
      expect(new Set(notes.map((l) => l.docNo)).size).toBe(filed.length)

      for (const r of filed) {
        const rows = notes.filter((l) => l.docNo === r.doc_no)
        expect(rows.length, r.doc_no).toBeGreaterThan(0)
        // Every credit note names the invoice it reverses — Rule 53(1)(e).
        expect(rows.every((l) => l.againstDocNo !== null && l.againstDocNo !== ''), r.doc_no).toBe(true)
        expect(rows.reduce((s, l) => s + l.total, 0), r.doc_no).toBe(-r.refund_total)
      }
    })
  })

  it('agrees rate for rate with what the bills and the credit notes hold', async () => {
    await withShop(async (db) => {
      const rows = await taxByRate(db, ALL)

      const expected = await db.query<{
        rate: number; taxable: number; cgst: number; sgst: number; igst: number
      }>(
        `SELECT rate, SUM(taxable) AS taxable, SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(igst) AS igst
           FROM (
             SELECT bi.tax_rate_bp AS rate, bi.taxable_value AS taxable, bi.cgst_amount AS cgst,
                    bi.sgst_amount AS sgst, bi.igst_amount AS igst
               FROM bill_items bi JOIN bills b ON b.id = bi.bill_id
              WHERE b.docstatus = 1 AND b.kind = 'sale'
             UNION ALL
             SELECT ri.tax_rate_bp, -ri.taxable_value, -ri.cgst_amount, -ri.sgst_amount, -ri.igst_amount
               FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id
              WHERE r.docstatus = 1
           )
          GROUP BY rate ORDER BY rate`,
      )

      expect(rows.map((r) => r.rateBp)).toEqual(expected.map((r) => r.rate))
      for (const [i, r] of rows.entries()) {
        expect(r.taxable, String(r.rateBp)).toBe(expected[i]!.taxable)
        expect(r.cgst + r.sgst + r.igst, String(r.rateBp)).toBe(
          expected[i]!.cgst + expected[i]!.sgst + expected[i]!.igst)
      }

      /* This shop has never billed out of state, so every paisa of it is
         CGST+SGST. It is asserted because it is the thing that would change
         silently if the supply type were ever derived from a live join again —
         and because it is the one fact about this database that makes the
         inter-state path untestable here. See `findings-real-shop.md`. */
      expect(rows.every((r) => r.igst === 0)).toBe(true)
    })
  })

  it('does not switch this shop_s tax off on the upgrade', async () => {
    await withShop(async (db) => {
      /* The single most consequential line of Phase 1b for the shop that is
         actually running this. TRT has no `shop_gstin` -- there was no screen
         that could save one until `services/shop.ts` -- and 29 submitted bills
         every one of which carries CGST and SGST.

         Read the missing field as "not registered" and this till stops charging
         GST the morning it upgrades, and the shop owes output tax on every sale
         it makes afterwards out of its own takings. The evidence of what it has
         been doing outranks the absence of a setting. */
      expect(await getSetting(db, 'shop_gstin')).toBeFalsy()
      expect(await loadTaxScheme(db)).toBe('regular')

      // And it is still a guess, so Settings still asks the owner to settle it.
      expect(await taxSchemeAnswered(db)).toBe(false)
    })
  })

  it('reports the recipient off the bill, which is now where it is written', async () => {
    await withShop(async (db) => {
      const lines = await gstLines(db, ALL)
      const invoices = lines.filter((l) => l.kind === 'invoice' && l.gstin !== '')

      const expected = await db.query<{ doc_no: string; customer_gstin: string }>(
        `SELECT doc_no, customer_gstin FROM bills
          WHERE docstatus = 1 AND kind = 'sale' AND customer_gstin IS NOT NULL`)

      expect(new Set(invoices.map((l) => l.docNo)).size).toBe(expected.length)
      for (const b of expected) {
        const row = invoices.find((l) => l.docNo === b.doc_no)
        expect(row?.gstin, b.doc_no).toBe(b.customer_gstin)
      }

      /* A credit note is issued to whoever the invoice was issued to, and takes
         its GSTIN from that invoice rather than from the customer record — the
         same rule, for the same reason. */
      for (const note of lines.filter((l) => l.kind === 'credit_note')) {
        const against = lines.find((l) => l.kind === 'invoice' && l.docNo === note.againstDocNo)
        expect(against, note.docNo).toBeDefined()
        expect(note.gstin, note.docNo).toBe(against!.gstin)
        expect(note.customerName, note.docNo).toBe(against!.customerName)
      }
    })
  })
})
