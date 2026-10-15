import type { SqlDriver } from '../../db/driver.js'
import type { Money } from '../../money.js'
import { cancelBill } from '../billing.js'
import { cancelReturn } from '../returns.js'
import { cancelPayment } from '../payments.js'
import type { Discrepancy, Remedy } from './types.js'

/*
 * The way out of a thing done twice, on the warning itself.
 *
 * Two counters that could not reach each other each did something right on
 * its own -- took the payment, took the item back, corrected the bill -- and
 * the shop is told once they meet. Telling it was half the job: the warning
 * named document numbers, and putting one right meant finding that document
 * on another screen and a button there. So each such warning carries the
 * documents to choose between, each with where and when it was done, and one
 * press cancels the one that should not stand -- through the same service the
 * document's own screen uses, so the same permission and the same closed
 * books apply.
 */

/** Why a remedy's cancel is recorded, in the document's history. */
const REASON = 'Done twice on two counters while they could not reach each other'

interface Doc { id: string; doc_no: string; amount: number | null; at: string | null }

/** Every warning of a kind that can be put right by cancelling one document, with those documents. */
export async function withRemedies(db: SqlDriver, found: Discrepancy[]): Promise<Discrepancy[]> {
  const counters = await db.query<{ prefix: string; name: string }>(`SELECT prefix, name FROM registers`)
  /* A document's number carries its counter: `RBC/2627/00004` is a receipt from
     counter BC. Not every document records the counter any other way. */
  const whereOf = (docNo: string): string | null =>
    counters.find((c) => docNo.slice(1).startsWith(`${c.prefix}/`))?.name ?? null

  const out: Discrepancy[] = []
  for (const d of found) {
    const id = d.key.split(':')[1] ?? ''
    const docs = await documentsFor(db, d.kind, id)
    if (docs === null) { out.push(d); continue }
    const act = ACT[d.kind]!
    const remedies: Remedy[] = docs.map((doc) => ({
      act, id: doc.id, docNo: doc.doc_no, amount: doc.amount as Money | null,
      where: whereOf(doc.doc_no), at: doc.at,
    }))
    out.push({ ...d, remedies })
  }
  return out
}

const ACT: Partial<Record<Discrepancy['kind'], Remedy['act']>> = {
  refunded_twice: 'cancel_return',
  refunded_and_cancelled: 'cancel_return',
  paid_twice: 'cancel_payment',
  supplier_overpaid: 'cancel_payment',
  corrected_twice: 'cancel_bill',
  order_billed_twice: 'cancel_bill',
}

/** The documents a warning is about, or null for a kind that is not put right by cancelling one. */
async function documentsFor(db: SqlDriver, kind: Discrepancy['kind'], id: string): Promise<Doc[] | null> {
  switch (kind) {
    case 'refunded_twice':
      // raw: each return against one line, with its own refund.
      return db.query<Doc>(
        `SELECT DISTINCT r.id, r.doc_no, r.refund_total AS amount, r.created_at AS at
           FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id AND r.docstatus = 1
          WHERE ri.bill_item_id = ? ORDER BY r.created_at`, [id])
    case 'refunded_and_cancelled':
      return db.query<Doc>(
        `SELECT r.id, r.doc_no, r.refund_total AS amount, r.created_at AS at
           FROM sales_returns r WHERE r.bill_id = ? AND r.docstatus = 1 ORDER BY r.created_at`, [id])
    case 'paid_twice':
      return db.query<Doc>(
        `SELECT p.id, p.doc_no, p.amount, p.created_at AS at
           FROM payment_allocations a JOIN payment_entries p ON p.id = a.payment_id AND p.docstatus = 1
          WHERE a.bill_id = ? ORDER BY p.created_at`, [id])
    case 'supplier_overpaid':
      return db.query<Doc>(
        `SELECT p.id, p.doc_no, p.amount, p.created_at AS at
           FROM payment_entries p
          WHERE p.supplier_id = ? AND p.party_type = 'supplier' AND p.docstatus = 1 AND p.direction = 'out'
          ORDER BY p.created_at`, [id])
    case 'corrected_twice':
      return db.query<Doc>(
        `SELECT b.id, b.doc_no, b.grand_total AS amount, b.created_at AS at
           FROM bills b WHERE b.amended_from = ? AND b.docstatus = 1 ORDER BY b.created_at`, [id])
    case 'order_billed_twice':
      return db.query<Doc>(
        `SELECT DISTINCT b.id, b.doc_no, b.grand_total AS amount, b.created_at AS at
           FROM bill_fulfilments bf JOIN bills b ON b.id = bf.bill_id AND b.docstatus = 1
          WHERE bf.document_item_id = ? ORDER BY b.created_at`, [id])
    default:
      return null
  }
}

export type RemedyResult = { ok: true; docNo: string } | { ok: false; why: string }

/** Cancels the one document a person chose, through its own service. */
export async function applyRemedy(db: SqlDriver, remedy: Remedy, actorId: string): Promise<RemedyResult> {
  const result = remedy.act === 'cancel_payment'
    ? await cancelPayment(db, { paymentId: remedy.id, reason: REASON, actorId })
    : remedy.act === 'cancel_return'
      ? await cancelReturn(db, { returnId: remedy.id, reason: REASON, actorId })
      : await cancelBill(db, { billId: remedy.id, reason: REASON, actorId })
  if (result.ok) return { ok: true, docNo: remedy.docNo }
  return {
    ok: false,
    why: 'code' in result && result.code === 'PERIOD_CLOSED'
      ? `${remedy.docNo} is in books that have been closed, so it cannot be cancelled here.`
      : `${remedy.docNo} could not be cancelled${'code' in result ? ` (${String(result.code)})` : ''}.`,
  }
}
