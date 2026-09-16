import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { MIGRATIONS } from '../src/db/migrations.js'

/**
 * Migration 028, replayed over a real shop's bills.
 *
 * 027 was written by hand and the first version of it silently produced
 * `bill:MR2627` — a scope key nothing reads, which would have restarted the
 * invoice series at one. It was caught by running it against a copy of the
 * shop's database and not by any test, because no fixture had the rows that
 * made it visible. 028 rewrites more rows than 027 did, so it gets the same
 * treatment before anything trusts it.
 *
 * What is asserted is what a bad migration would break and a passing test
 * suite would not notice: that nothing was lost, that the backfill reached
 * every row it was supposed to reach, and that the column deliberately left
 * empty is still empty.
 *
 * Skipped when the fixture is absent, which is the normal state — it is
 * gitignored real trade and CI has never seen it. `npm run pull-shop-db`
 * creates it. A skip is not a pass, and the phase checklist says so.
 */

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', '..', 'tools', 'fixtures', 'real-shop.db')
const MIGRATIONS_DIR = join(here, '..', 'migrations')

const present = existsSync(FIXTURE)

/** A throwaway copy, migrated to head. The fixture itself is never written to. */
function migrated(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shopos-028-'))
  const path = join(dir, 'shop.db')
  copyFileSync(FIXTURE, path)

  const db = new Database(path)
  const from = db.pragma('user_version', { simple: true }) as number

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    db.exec('BEGIN')
    db.exec(readFileSync(join(MIGRATIONS_DIR, m.name), 'utf8'))
    db.exec(`PRAGMA user_version = ${m.version}`)
    db.exec('COMMIT')
  }
  return { db, dir }
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

describe.skipIf(!present)('028 against the shop that has been trading', () => {
  it('arrives at head with the database still sound', () => {
    const { db, dir } = migrated()
    try {
      expect(db.pragma('user_version', { simple: true }))
        .toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version)
      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check).toBe('ok')
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loses nothing', () => {
    // 028 only adds columns and rewrites values in place. A row count that
    // moved would mean a CASCADE fired or an INSERT ran that should not have.
    const before = new Database(FIXTURE, { readonly: true })
    const counts = ['bills', 'bill_items', 'customers', 'sales_returns', 'sales_return_items']
      .map((t) => [t, count(before, `SELECT COUNT(*) n FROM ${t}`)] as const)
    before.close()

    const { db, dir } = migrated()
    try {
      for (const [table, was] of counts) {
        expect(count(db, `SELECT COUNT(*) n FROM ${table}`), table).toBe(was)
      }
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stamps every submitted and cancelled bill with a supply type', () => {
    const { db, dir } = migrated()
    try {
      /* The one that matters. A bill left null here renders as an invoice that
         cannot say whether it charged CGST+SGST or IGST, and the GST export
         cannot place it. */
      expect(count(db,
        `SELECT COUNT(*) n FROM bills WHERE docstatus IN (1, 2) AND supply_type IS NULL`))
        .toBe(0)

      // Derived from where the tax actually landed, so a shop that has never
      // billed out of state is entirely intra-state and says so.
      expect(count(db, `SELECT COUNT(*) n FROM bills WHERE supply_type = 'inter_state'`))
        .toBe(count(db,
          `SELECT COUNT(DISTINCT bill_id) n FROM bill_items WHERE igst_amount > 0`))
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes the recipient snapshot from the customer as they are today', () => {
    const { db, dir } = migrated()
    try {
      const withGstin = count(db,
        `SELECT COUNT(*) n FROM bills b JOIN customers c ON c.id = b.customer_id
          WHERE b.docstatus IN (1, 2) AND c.gstin IS NOT NULL`)
      expect(count(db,
        `SELECT COUNT(*) n FROM bills WHERE customer_gstin IS NOT NULL`)).toBe(withGstin)
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the place of supply empty rather than inventing one', () => {
    const { db, dir } = migrated()
    try {
      /* Every `customers.state_code` was the literal '33' that customers.ts
         writes into the INSERT — never a parameter, so no person ever entered
         one. Backfilling from it would stamp a fabrication onto an invoice. */
      expect(count(db, `SELECT COUNT(*) n FROM bills WHERE customer_state_code IS NOT NULL`))
        .toBe(0)
      expect(count(db, `SELECT COUNT(*) n FROM customers WHERE state_code IS NOT NULL`))
        .toBe(0)
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives every returned line the rate it was actually charged at', () => {
    const { db, dir } = migrated()
    try {
      // From the bill line it reverses, never from the product's rate today.
      const wrong = db.prepare(
        `SELECT ri.id FROM sales_return_items ri
           JOIN bill_items bi ON bi.id = ri.bill_item_id
          WHERE ri.tax_rate_bp IS NOT bi.tax_rate_bp
             OR ri.hsn_code IS NOT bi.hsn_code`,
      ).all()
      expect(wrong).toEqual([])
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults reverse charge to no, on every row', () => {
    const { db, dir } = migrated()
    try {
      expect(count(db, `SELECT COUNT(*) n FROM bills WHERE reverse_charge <> 0`)).toBe(0)
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true })
    }
  })
})
