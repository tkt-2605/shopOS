import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { splitTax } from '../src/domain/tax.js'
import { paise } from '../src/money.js'

/**
 * The tax split, replayed over every line a real shop has actually billed.
 *
 * The standing instruction is that a claim about correctness is verified
 * against the owner's database rather than a fixture, because the fixture has
 * been caught lying before. This is that check for `splitTax`: pull the real
 * `bill_items`, run each line's stored total and rate back through the code as
 * it stands now, and assert the properties that must hold for all of them.
 *
 * It does **not** assert that the new figures match the stored ones. They must
 * not: 29 of the 51 rows were stored with unequal halves, and the whole point
 * is that the code no longer produces them. What is asserted is the shape —
 * equal halves, and a total that still comes to the shelf price.
 *
 * Skipped when the fixture is absent, which is the normal state: it is
 * gitignored real trade, and CI has never seen it. `npm run pull-shop-db`
 * creates it. A skip here is not a pass, and the phase checklists say so.
 */

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', '..', 'tools', 'fixtures', 'real-shop.db')

interface Line {
  line_total: number
  tax_rate_bp: number
  cgst_amount: number
  sgst_amount: number
}

const present = existsSync(FIXTURE)

describe.skipIf(!present)('every line the shop has billed', () => {
  function lines(): Line[] {
    const db = new Database(FIXTURE, { readonly: true, fileMustExist: true })
    try {
      return db.prepare(
        `SELECT line_total, tax_rate_bp, cgst_amount, sgst_amount FROM bill_items`,
      ).all() as Line[]
    } finally {
      db.close()
    }
  }

  it('has lines to check at all', () => {
    // A fixture that exists and is empty would make every assertion below
    // vacuously true, which is the failure mode this whole file exists against.
    expect(lines().length).toBeGreaterThan(0)
  })

  it('now produces equal halves for all of them', () => {
    const unequal: string[] = []
    for (const line of lines()) {
      const tax = splitTax(paise(line.line_total), line.tax_rate_bp)
      if (tax.cgst !== tax.sgst) {
        unequal.push(`${line.line_total} @ ${line.tax_rate_bp}bp → ${tax.cgst}/${tax.sgst}`)
      }
    }
    expect(unequal).toEqual([])
  })

  it('still charges each of them exactly what was charged', () => {
    for (const line of lines()) {
      const tax = splitTax(paise(line.line_total), line.tax_rate_bp)
      expect(
        tax.taxableValue + tax.cgst + tax.sgst,
        `${line.line_total} @ ${line.tax_rate_bp}bp`,
      ).toBe(line.line_total)
    }
  })

  it('confirms the stored rows are the ones that were wrong', () => {
    /* The evidence, kept rather than summarised: if this ever reads zero, the
       fixture has been replaced with a different shop and the counts quoted in
       `docs/specs/findings-real-shop.md` no longer describe it. */
    const stored = lines().filter((l) => l.cgst_amount !== l.sgst_amount)
    expect(stored.length).toBeGreaterThan(0)
    for (const line of stored) {
      expect(Math.abs(line.cgst_amount - line.sgst_amount)).toBe(1)
    }
  })

  it('moves no more than a paisa of tax on any line', () => {
    // The fix corrects a rounding rule; it must not change what a sale costs.
    for (const line of lines()) {
      const tax = splitTax(paise(line.line_total), line.tax_rate_bp)
      const was = line.cgst_amount + line.sgst_amount
      expect(
        Math.abs(tax.taxTotal - was),
        `${line.line_total} @ ${line.tax_rate_bp}bp`,
      ).toBeLessThanOrEqual(1)
    }
  })
})
