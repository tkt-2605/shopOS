import type { SqlDriver } from '../db/driver.js'

/**
 * Numbers are scoped per register and per fiscal year. The register prefix is not
 * cosmetic — two terminals billing offline must not both mint INV-0042, and a
 * globally sequential counter cannot survive a second till.
 */

export type DocType =
  | 'bill' | 'return' | 'payment' | 'stock_entry' | 'stock_count'
  | 'quotation' | 'sales_order' | 'purchase_order'

/**
 * One letter per kind of document, because sixteen characters is the whole
 * budget.
 *
 * Rule 46(b) caps an invoice serial at **16 characters**, and Rule 53 does the
 * same for a credit or debit note. The old format — `INV/MR/26-27/00001` — is
 * eighteen, and twenty-two with the six-character prefix `createRegister` used
 * to allow. Every bill raised before this was over the limit, and it would have
 * blocked e-invoicing outright.
 *
 * A letter rather than nothing, because the type has to stay *in the printed
 * number*. Dropping it would save two characters and let a bill and a credit
 * note print the identical string — they are separate series in
 * `doc_sequences`, so both would legitimately reach `MR/2627/00001`, and a
 * customer holding two pieces of paper with one number on them is a worse
 * problem than a long serial.
 */
const MARK: Record<DocType, string> = {
  bill: 'B',
  return: 'C',          // credit note
  payment: 'R',         // receipt
  stock_entry: 'S',
  stock_count: 'T',
  quotation: 'Q',
  sales_order: 'O',
  purchase_order: 'P',
}

/**
 * Indian fiscal year runs April to March: 2026-06-01 is "26-27".
 *
 * **Local, not UTC**, and that is not a style preference. This used to read
 * `getUTCFullYear()`/`getUTCMonth()` while the rest of the codebase deliberately
 * uses local getters — `businessDate()` in `dates.ts` says so, and CLAUDE.md
 * calls it a rule.
 *
 * India is UTC+5:30, so a bill rung between midnight and half past five on the
 * first of April is still the thirty-first of March in UTC. That did not merely
 * print the wrong year: the fiscal year is part of the `doc_sequences` scope
 * key, so the sale was counted into the *outgoing* year's series and the new
 * year's first bill was numbered as if it were last year's. A shop trading past
 * midnight on 1 April would find a year-end already closed and filed.
 */
export function fiscalYear(date: Date): string {
  const year = date.getFullYear()
  const startYear = date.getMonth() >= 3 ? year : year - 1
  return `${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

/**
 * The same fiscal year without the hyphen, for document numbers: `2627`.
 *
 * Derived from `fiscalYear` rather than computed again, so the April rule above
 * has exactly one definition and the two renderings cannot drift.
 */
export function fiscalYearTag(date: Date): string {
  return fiscalYear(date).replace('-', '')
}

/**
 * The longest a document number may be, by law.
 *
 * `B` + prefix(4) + `/` + `2627` + `/` + `00001` = 16 exactly, which is why
 * `createRegister` caps a prefix at four characters. A shop that was given a
 * longer prefix before this cannot be changed once it has billed against it —
 * the prefix is part of every number already printed — so `docNoFits` exists to
 * let a screen say so rather than let it be discovered by a rejected e-invoice.
 */
export const MAX_DOC_NO = 16

export function docNoFits(docNo: string): boolean {
  return docNo.length <= MAX_DOC_NO
}

export async function nextDocNo(
  tx: SqlDriver,
  docType: DocType,
  registerPrefix: string,
  on: Date = new Date(),
): Promise<string> {
  const fy = fiscalYearTag(on)
  const scope = `${docType}:${registerPrefix}:${fy}`

  await tx.execute(
    `INSERT INTO doc_sequences (scope, last_value) VALUES (?, 0) ON CONFLICT (scope) DO NOTHING`,
    [scope],
  )
  await tx.execute(`UPDATE doc_sequences SET last_value = last_value + 1 WHERE scope = ?`, [scope])

  const row = await tx.get<{ last_value: number }>(
    `SELECT last_value FROM doc_sequences WHERE scope = ?`,
    [scope],
  )
  const seq = row?.last_value ?? 1

  return `${MARK[docType]}${registerPrefix}/${fy}/${String(seq).padStart(5, '0')}`
}

export async function peekDocNo(db: SqlDriver, docType: DocType, registerPrefix: string, on: Date = new Date()): Promise<string> {
  const fy = fiscalYearTag(on)
  const row = await db.get<{ last_value: number }>(
    `SELECT last_value FROM doc_sequences WHERE scope = ?`,
    [`${docType}:${registerPrefix}:${fy}`],
  )
  return `${MARK[docType]}${registerPrefix}/${fy}/${String((row?.last_value ?? 0) + 1).padStart(5, '0')}`
}
