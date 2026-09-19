/**
 * Document lifecycle. A submitted document is immutable — it moved stock, took
 * money, and printed. Correction is cancel-then-amend into a new document that
 * links back, so the original stays on the record and the trail is intact.
 */

export const DRAFT = 0
export const SUBMITTED = 1
export const CANCELLED = 2

export type DocStatus = typeof DRAFT | typeof SUBMITTED | typeof CANCELLED

export type DocAction = 'save' | 'submit' | 'cancel' | 'delete'

const LEGAL: ReadonlyArray<readonly [DocStatus, DocAction, DocStatus | null]> = [
  [DRAFT, 'save', DRAFT],
  [DRAFT, 'submit', SUBMITTED],
  [DRAFT, 'delete', null],
  [SUBMITTED, 'cancel', CANCELLED],
]

export class DocStatusError extends Error {
  constructor(
    readonly entity: string,
    readonly from: DocStatus,
    readonly action: DocAction,
  ) {
    super(`cannot ${action} a ${label(from)} ${entity}`)
    this.name = 'DocStatusError'
  }
}

export function canApply(from: DocStatus, action: DocAction): boolean {
  return LEGAL.some(([f, a]) => f === from && a === action)
}

export function nextStatus(from: DocStatus, action: DocAction): DocStatus | null {
  const rule = LEGAL.find(([f, a]) => f === from && a === action)
  if (rule === undefined) throw new DocStatusError('document', from, action)
  return rule[2]
}

export function assertCanApply(entity: string, from: DocStatus, action: DocAction): void {
  if (!canApply(from, action)) throw new DocStatusError(entity, from, action)
}

/** Guards every write path into a document's own row. */
export function assertEditable(entity: string, status: DocStatus): void {
  if (status !== DRAFT) throw new DocStatusError(entity, status, 'save')
}

/** A document may only be amended from one that was cancelled. */
export function assertAmendable(entity: string, status: DocStatus): void {
  if (status !== CANCELLED) {
    throw new Error(`cannot amend a ${label(status)} ${entity} — cancel it first`)
  }
}

export function isDraft(status: DocStatus): boolean {
  return status === DRAFT
}

export function isSubmitted(status: DocStatus): boolean {
  return status === SUBMITTED
}

export function isCancelled(status: DocStatus): boolean {
  return status === CANCELLED
}

/** Only submitted documents post to ledgers. */
export function affectsLedgers(status: DocStatus): boolean {
  return status === SUBMITTED
}

export function label(status: DocStatus): string {
  switch (status) {
    case DRAFT:
      return 'draft'
    case SUBMITTED:
      return 'submitted'
    case CANCELLED:
      return 'cancelled'
  }
}

export function parseDocStatus(value: number): DocStatus {
  if (value === DRAFT || value === SUBMITTED || value === CANCELLED) return value
  throw new RangeError(`invalid docstatus: ${value}`)
}

/**
 * The same rule, for a row arriving from another till.
 *
 * `assertEditable` guards every write path into a document's own row on *this*
 * machine. The merge is the one write path it never covered: `applyRecord`
 * compares a revision and a timestamp and knows nothing about docstatus, so a
 * peer could overwrite a submitted invoice and the later timestamp would win.
 *
 * That is not hypothetical and it does not need a faulty till to happen. A bill
 * is drafted, and before 042 the draft replicated. One counter submits it; the
 * other, which has not heard, carries on typing into its copy. The second till's
 * `updated_at` is later, so its draft wins — and a submitted invoice, printed,
 * with stock moved against it, quietly takes a different total. GSTR-1 is filed
 * off that number.
 *
 * ── What is frozen ────────────────────────────────────────────────────────
 *
 * Once the row here is submitted or cancelled, the columns below may not be
 * changed by anybody else. They are what the document *is*: which document,
 * whose, when, for how much, and under what place of supply. A disagreement
 * about any of them is not two versions of one edit, it is two different
 * documents wearing one number.
 *
 * Deliberately **not** frozen, and each for a reason:
 *
 *   `paid_total`     a credit bill is paid afterwards, and the payment is
 *                    allocated on whichever till took the money.
 *   `docstatus`      it still has one move left: cancelling. See below.
 *   `cancelled_*`    which is how that move is recorded.
 *   `closed_at` and the cash-counting columns, because closing a drawer is the
 *                    ordinary end of a session rather than an edit to it.
 *   `updated_at`, `rev`, `origin_id` — the merge's own bookkeeping.
 *
 * The line tables are not listed here at all and are not meant to be. A
 * submitted document's lines legitimately change: `bill_items.returned_qty`
 * when something comes back, `document_items.fulfilled_qty` as an order is
 * filled. Refusing those would silently drop returns and fulfilment between
 * tills, which is the mistake an earlier draft of this rule made.
 *
 * ── Whole record, or none of it ───────────────────────────────────────────
 *
 * A refusal takes the record out entirely rather than keeping the frozen columns
 * and taking the rest. Half a document is a document nobody raised: this till's
 * total with the other till's lines under it, adding up to neither. And since a
 * legitimate post-submission change — a return, a payment — arrives with every
 * frozen column identical, nothing legitimate is ever refused by this.
 */

/**
 * The seven tables that carry a docstatus. Kept as a set rather than derived
 * from the schema so that adding an eighth is a decision somebody makes here.
 */
export const DOCUMENT_TABLES: ReadonlySet<string> = new Set([
  'bills', 'sales_returns', 'payment_entries', 'stock_entries',
  'stock_counts', 'documents', 'cash_sessions',
])

/**
 * Columns frozen once the local row is submitted, wherever they appear.
 *
 * One list rather than a list per table: these names mean the same thing in
 * every document in this schema, and seven lists would be seven places for the
 * eighth document to be forgotten.
 */
const FROZEN: ReadonlySet<string> = new Set([
  // Which document, and whose
  'doc_no', 'posting_date', 'created_by', 'amended_from',
  'register_id', 'session_id', 'customer_id', 'bill_id',
  'idempotency_key',
  // What it came to
  'subtotal', 'discount', 'taxable_total', 'tax_total', 'round_off',
  'grand_total', 'credit_total', 'refund_total', 'tax_reversed', 'amount',
  // The 028 snapshot — what the tax on it was worked out from
  'place_of_supply', 'supply_type', 'customer_gstin', 'customer_state_code',
  'customer_address',
])

/**
 * Why an incoming row must not be applied over this one, or null to allow it.
 *
 * The sentence comes back rather than a boolean because it goes straight into
 * `sync_conflicts` for somebody to read, and "a submitted bill, and they have a
 * different grand_total" is the whole of what a person needs to go and look.
 */
export function refusedAsSubmitted(
  table: string,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): string | null {
  if (!DOCUMENT_TABLES.has(table)) return null

  const was = Number(mine['docstatus'])
  if (!Number.isFinite(was) || was < SUBMITTED) return null

  /* Never backwards. A cancelled document that is un-cancelled by a merge is
     stock and money moving again with nothing on the screen to say why, and a
     submitted one turning back into a draft is an invoice that can be edited. */
  const now = Number(theirs['docstatus'])
  if (Number.isFinite(now) && now < was) {
    return `a ${label(was as DocStatus)} document, and they have it as ${label(now as DocStatus)}`
  }

  const changed = [...FROZEN].filter(
    (column) => column in theirs && column in mine && String(theirs[column]) !== String(mine[column]),
  )
  if (changed.length === 0) return null

  return `a ${label(was as DocStatus)} document, and they have a different `
    + `${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`
}
