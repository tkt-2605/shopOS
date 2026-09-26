import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { myRegisterPrefix } from './registers.js'

/**
 * Numbers are scoped per register and per fiscal year. The register prefix is not
 * cosmetic — two terminals billing offline must not both mint INV-0042, and a
 * globally sequential counter cannot survive a second till.
 */

/**
 * The prefix a number minted on *this* till belongs under.
 *
 * The rule above was stated when this file was written and then broken by five
 * callers, each of which passed a constant where a register belonged: stock
 * entries and stock counts hard-coded `'MR'`, and the three payment paths plus
 * the opening balance took an optional prefix that no screen ever supplied and
 * fell back to `'MR'` as well.
 *
 * So every till in the shop drew from a series called `stock_entry:MR:2627`
 * while `doc_sequences` is deliberately *not* replicated -- it is the one table
 * whose whole reason for staying local is that taking either side of it would
 * hand two tills the same invoice number. One series name, one counter per
 * machine, and `doc_no` is `UNIQUE` on every document table.
 *
 * That fails in two different ways and the quiet one is worse:
 *
 * - The till that has *received* the other's document cannot mint at all. Its
 *   own counter is behind, so it produces a number the incoming row already
 *   holds, the UNIQUE rejects it, and the transaction rolls back -- which means
 *   the counter never advances either, so every retry produces the identical
 *   number for ever. A shop in this state cannot post stock in, and no amount
 *   of trying again will change it.
 * - Two tills that mint *before* they meet both succeed locally, and one of the
 *   two documents is then quarantined on arrival. Stage 1's quarantine is what
 *   turns that from silent loss into a row on a screen, which is the argument
 *   for it -- but a payment that was taken and did not arrive is not a thing to
 *   rely on a safety net for.
 *
 * Found by posting stock in on a real till, not by a test: the bench had never
 * had two tills make a *stock entry*, only bills, which partition correctly.
 *
 * `fallback` is for a till with no counter of its own. A shop with one till
 * cannot collide with anybody, which is what makes it safe there and nowhere
 * else.
 */
export async function seriesPrefix(db: SqlDriver, fallback: string): Promise<string> {
  return (await myRegisterPrefix(db)) ?? fallback
}

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

  await q(tx).insert(schema.docSequences)
    .values({ scope, lastValue: 0 })
    .onConflictDoNothing()
  await q(tx).update(schema.docSequences)
    .set({ lastValue: sql`${schema.docSequences.lastValue} + 1` })
    .where(eq(schema.docSequences.scope, scope))

  const [row] = await q(tx)
    .select({ lastValue: schema.docSequences.lastValue })
    .from(schema.docSequences)
    .where(eq(schema.docSequences.scope, scope))
  const stem = `${MARK[docType]}${registerPrefix}/${fy}/`
  let seq = row?.lastValue ?? 1

  /* Never below a number this database already holds. The counter stays on
     each machine, so it knows nothing of documents that arrived by sync: a
     till restored from an older backup, or one that took over a counter with
     `takeRegister`, starts behind bills it has since pulled back. It would
     then mint a number an incoming row holds, the UNIQUE would roll the
     transaction back with the counter, and every retry would fail the same
     way -- a till that can no longer bill. */
  const highest = await highestIssued(tx, docType, stem)
  if (seq <= highest) {
    seq = highest + 1
    await q(tx).update(schema.docSequences)
      .set({ lastValue: seq })
      .where(eq(schema.docSequences.scope, scope))
  }

  return `${stem}${String(seq).padStart(5, '0')}`
}

/** Where each kind of document keeps its numbers. */
const NUMBERED = {
  bill: schema.bills,
  return: schema.salesReturns,
  payment: schema.paymentEntries,
  stock_entry: schema.stockEntries,
  stock_count: schema.stockCounts,
  quotation: schema.documents,
  sales_order: schema.documents,
  purchase_order: schema.documents,
} as const satisfies Record<DocType, { docNo: unknown }>

/** The highest serial under `stem` already in the database, or 0. */
async function highestIssued(tx: SqlDriver, docType: DocType, stem: string): Promise<number> {
  const table = NUMBERED[docType]
  const [row] = await q(tx)
    .select({ top: sql<number | null>`MAX(CAST(substr(${table.docNo}, ${stem.length + 1}) AS INTEGER))` })
    .from(table)
    /* A range rather than LIKE or substr: it seeks the UNIQUE index on doc_no
       instead of scanning it on every number minted, and a `_` in a prefix is
       not read as a wildcard. Everything under the stem sorts between the
       stem itself and the stem followed by the highest character there is. */
    .where(sql`${table.docNo} >= ${stem} AND ${table.docNo} < ${stem} || char(1114111)`)
  return row?.top ?? 0
}

export async function peekDocNo(db: SqlDriver, docType: DocType, registerPrefix: string, on: Date = new Date()): Promise<string> {
  const fy = fiscalYearTag(on)
  const [row] = await q(db)
    .select({ lastValue: schema.docSequences.lastValue })
    .from(schema.docSequences)
    .where(eq(schema.docSequences.scope, `${docType}:${registerPrefix}:${fy}`))
  const stem = `${MARK[docType]}${registerPrefix}/${fy}/`
  // Floored as `nextDocNo` is, so the number shown is the number minted.
  const next = Math.max(row?.lastValue ?? 0, await highestIssued(db, docType, stem)) + 1
  return `${stem}${String(next).padStart(5, '0')}`
}
