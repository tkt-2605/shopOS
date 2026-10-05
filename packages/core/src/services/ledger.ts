import { MERGE_BUDGET_MS, type SqlDriver } from '../db/driver.js'
import { UnbalancedPostingError } from '../domain/ledger.js'
import { postGl, reverseGl } from './ledger/post.js'
import { build, reversalStockVoucher, stockValueOf, type VoucherType } from './ledger/vouchers.js'

/*
 * The general ledger, as the services see it: post a document, reverse one,
 * and fill in whatever is missing.
 *
 * In pieces: `domain/ledger.ts` is the chart and the rule that every posting
 * balances, `ledger/vouchers.ts` what each kind of document posts, and
 * `ledger/post.ts` the writing. A service calls one of the two functions below
 * inside its own transaction, after the document's own rows are written, and
 * that is the whole of its knowledge of the books.
 */

export type { VoucherType } from './ledger/vouchers.js'

/** Posts a submitted document's entries. Nothing for a document that posts none. */
export async function postVoucherGl(tx: SqlDriver, type: VoucherType, id: string): Promise<void> {
  const built = await build(tx, type, id)
  if (built) await postGl(tx, built.voucher, built.lines)
}

/**
 * Reverses a cancelled document's entries, posting the originals first if
 * they were never posted -- a document cancelled on a till that predates the
 * ledger arrives here with neither.
 */
export async function reverseVoucherGl(tx: SqlDriver, type: VoucherType, id: string): Promise<void> {
  const built = await build(tx, type, id)
  if (!built) return
  await postGl(tx, built.voucher, built.lines)
  const stock = reversalStockVoucher(type)
  await reverseGl(tx, built.voucher, stock === null ? null : await stockValueOf(tx, stock, id))
}

/** A document that should have entries: submitted, or cancelled (which needs its reversal too). */
const POSTED_OR_CANCELLED = (alias: string, type: string) => `
  ${alias}.docstatus IN (1, 2)
  AND (NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.voucher_type = '${type}' AND g.voucher_id = ${alias}.id AND g.is_reversal = 0)
    OR (${alias}.docstatus = 2 AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.voucher_type = '${type}' AND g.voucher_id = ${alias}.id AND g.is_reversal = 1)))`

/*
 * raw: one select per kind of document, each joined against the ledger by its
 * own key, so that it can be asked about the whole shop (on opening) or about
 * just the documents a merge brought in (after one). The table each reads is
 * named here; the voucher types are `VoucherType`.
 */
const MISSING: Record<VoucherType, { table: string; select: string }> = {
  bill: {
    table: 'bills',
    select: `SELECT 'bill' AS type, b.id, b.docstatus, b.posting_date AS at FROM bills b
              WHERE ${POSTED_OR_CANCELLED('b', 'bill')}`,
  },
  sales_return: {
    table: 'sales_returns',
    select: `SELECT 'sales_return' AS type, r.id, r.docstatus, r.posting_date AS at FROM sales_returns r
              WHERE ${POSTED_OR_CANCELLED('r', 'sales_return')}`,
  },
  payment: {
    table: 'payment_entries',
    select: `SELECT 'payment' AS type, p.id, p.docstatus, p.posting_date AS at FROM payment_entries p
              WHERE NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.credit_note_id = p.id)
                AND ${POSTED_OR_CANCELLED('p', 'payment')}`,
  },
  stock_entry: {
    table: 'stock_entries',
    select: `SELECT 'stock_entry' AS type, e.id, e.docstatus, e.posting_date AS at FROM stock_entries e
              WHERE ${POSTED_OR_CANCELLED('e', 'stock_entry')}`,
  },
  cash_session: {
    table: 'cash_sessions',
    select: `SELECT 'cash_session' AS type, s.id, 1 AS docstatus, s.closed_at AS at FROM cash_sessions s
              WHERE s.closed_at IS NOT NULL AND COALESCE(s.variance, 0) <> 0
                AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.voucher_type = 'cash_session' AND g.voucher_id = s.id)`,
  },
  supplier_opening: {
    table: 'suppliers',
    select: `SELECT 'supplier_opening' AS type, s.id, 1 AS docstatus, COALESCE(s.opening_as_of, s.created_at) AS at
               FROM suppliers s
              WHERE (CASE WHEN s.opening_as_of IS NULL THEN 0 ELSE s.opening_balance END)
                 <> COALESCE((SELECT SUM(g.credit) - SUM(g.debit) FROM gl_entries g
                               WHERE g.voucher_type = 'supplier_opening' AND g.account = 'creditors'
                                 AND g.party_id = s.id), 0)`,
  },
  cash_payout: {
    table: 'cash_movements',
    select: `SELECT 'cash_payout' AS type, m.id, 1 AS docstatus, m.created_at AS at FROM cash_movements m
              WHERE m.source_type = 'expense'
                AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.voucher_type = 'cash_payout' AND g.voucher_id = m.id)`,
  },
}

/** The tables a merge can bring documents in through, and the voucher each one is. */
export const LEDGER_SOURCES: ReadonlyMap<string, VoucherType> = new Map(
  (Object.entries(MISSING) as [VoucherType, { table: string }][]).map(([type, m]) => [m.table, type]),
)

async function findMissing(
  db: SqlDriver,
  only?: ReadonlyMap<VoucherType, readonly string[]>,
): Promise<{ type: VoucherType; id: string; docstatus: number }[]> {
  const found: { type: VoucherType; id: string; docstatus: number; at: string }[] = []
  for (const [type, m] of Object.entries(MISSING) as [VoucherType, { select: string }][]) {
    const ids = only?.get(type)
    if (only && (!ids || ids.length === 0)) continue
    const alias = m.select.match(/FROM \w+ (\w)\b/)![1]
    /* Chunked: SQLite allows a few hundred bound values, and a merge can bring
       more documents than that. */
    for (let i = 0; i < (ids?.length ?? 1); i += 400) {
      const chunk = ids?.slice(i, i + 400)
      const where = chunk ? ` AND ${alias}.id IN (${chunk.map(() => '?').join(', ')})` : ''
      found.push(...await db.query<{ type: VoucherType; id: string; docstatus: number; at: string }>(
        m.select + where, chunk ?? []))
    }
  }
  return found.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/**
 * How many vouchers go into one transaction, so a long backfill does not hold
 * the counter. Each voucher is a dozen or so round trips to the Rust side, and
 * the till's watchdog rolls back a transaction left open past its budget -- at
 * 200 a batch the first open of a busy shop on a slow machine could run past
 * it, and then the app would fail to open, every time. Fifty a batch, and each
 * batch given the budget a merge gets.
 */
const BATCH = 50

export interface MissingGlOutcome {
  /** Documents whose entries were written now. */
  posted: number
  /**
   * Documents whose own figures do not add up, so no entries could be made for
   * them: `type:id`. Left for a person, never guessed at. A document a till
   * submits itself can never be here -- it would have been refused at submit.
   */
  unbalanced: string[]
}

/**
 * Posts every document that should have entries and has none.
 *
 * Run when the app opens and after every merge. Normally it finds nothing: a
 * document posts its own entries as it is submitted, and they travel with it.
 * It finds something on a shop's first open after updating to the ledger --
 * everything before it -- and after a merge that brought documents from a
 * till still on an older build. Idempotent, and safe on two tills at once:
 * the entries' ids come from the document, so two tills posting the same one
 * write the same rows.
 */
export async function postMissingGl(
  db: SqlDriver,
  /**
   * Only these documents, by voucher type -- what a merge brought in. Left out,
   * the whole shop, which is what opening the app asks for. A merge must not
   * walk every document the shop has ever raised to look at the three it was
   * sent (`atScale.test.ts`).
   */
  only?: ReadonlyMap<VoucherType, readonly string[]>,
): Promise<MissingGlOutcome> {
  const missing = await findMissing(db, only)
  const unbalanced: string[] = []
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH)
    await db.transaction(async (tx) => {
      for (const v of slice) {
        /* One document that does not add up must not stop the rest, and must
           not stop a sync: it is reported and skipped. Nothing of it is
           written -- a posting is checked before a row of it goes in. */
        try {
          if (v.docstatus === 2) await reverseVoucherGl(tx, v.type, v.id)
          else await postVoucherGl(tx, v.type, v.id)
        } catch (err) {
          if (!(err instanceof UnbalancedPostingError)) throw err
          unbalanced.push(`${v.type}:${v.id}`)
        }
      }
    }, { budgetMs: MERGE_BUDGET_MS })
  }
  return { posted: missing.length - unbalanced.length, unbalanced }
}
