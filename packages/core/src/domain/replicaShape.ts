/**
 * What replicates, and in what shape.
 *
 * This list exists three times in the schema already — once in 021's feed
 * triggers, once in 022's revision triggers, and once in whatever applies an
 * incoming change. Three copies of one list is three chances to add a table to
 * two of them, and the failure that causes is the quiet kind: a row that is fed
 * but never applied, or applied without its lines.
 *
 * So it is written here once, and `replicaShape.test.ts` checks it against the
 * triggers actually in the database. A table added to the schema without being
 * decided about fails the test run rather than going missing in a shop.
 *
 * ── Two kinds of thing ──────────────────────────────────────────────────────
 *
 * **Records** replicate as themselves and are what the merge rule compares.
 *
 * **Lines** do not replicate on their own at all. A bill travels as a bill, with
 * its items, its payments and its fulfilments, because half a bill is not a
 * smaller bill — it is a wrong one. That is also why applying a record replaces
 * its lines outright rather than merging them one by one: the winning side's
 * document is the document, and a line-by-line merge of two versions of one bill
 * produces a bill neither till ever had.
 */

import type { Row } from '../db/driver.js'

export interface RecordShape {
  table: string
  /** The column the row is identified by. `settings` is keyed by its name. */
  key: string
  /** Tables holding this record's lines, and the column pointing back here. */
  lines: ReadonlyArray<{ table: string; parentKey: string }>
}

/**
 * Every table whose rows travel on their own.
 *
 * `stock_ledger` and `loyalty_entries` carry no `rev` and do not need one: they
 * are append-only and never edited, so two tills cannot disagree about a row —
 * they can only each be missing some of the other's, which is a union rather
 * than a merge.
 */
export const REPLICATED: readonly RecordShape[] = [
  { table: 'attachments', key: 'id', lines: [] },
  {
    table: 'bills',
    key: 'id',
    lines: [
      { table: 'bill_items', parentKey: 'bill_id' },
      { table: 'bill_payments', parentKey: 'bill_id' },
      { table: 'bill_fulfilments', parentKey: 'bill_id' },
      { table: 'loyalty_redemptions', parentKey: 'bill_id' },
    ],
  },
  {
    table: 'cash_sessions',
    key: 'id',
    lines: [{ table: 'cash_movements', parentKey: 'session_id' }],
  },
  { table: 'categories', key: 'id', lines: [] },
  { table: 'customer_item_prices', key: 'id', lines: [] },
  { table: 'customers', key: 'id', lines: [] },
  { table: 'doc_formats', key: 'id', lines: [] },
  {
    table: 'documents',
    key: 'id',
    lines: [{ table: 'document_items', parentKey: 'document_id' }],
  },
  { table: 'item_prices', key: 'id', lines: [] },
  { table: 'loyalty_entries', key: 'id', lines: [] },
  {
    table: 'payment_entries',
    key: 'id',
    lines: [{ table: 'payment_allocations', parentKey: 'payment_id' }],
  },
  { table: 'price_lists', key: 'id', lines: [] },
  { table: 'product_barcodes', key: 'id', lines: [] },
  { table: 'product_units', key: 'id', lines: [] },
  { table: 'products', key: 'id', lines: [] },
  { table: 'registers', key: 'id', lines: [] },
  {
    table: 'roles',
    key: 'id',
    lines: [
      { table: 'role_pages', parentKey: 'role_id' },
      { table: 'role_permissions', parentKey: 'role_id' },
    ],
  },
  {
    table: 'sales_returns',
    key: 'id',
    lines: [{ table: 'sales_return_items', parentKey: 'return_id' }],
  },
  { table: 'settings', key: 'key', lines: [] },
  {
    table: 'stock_counts',
    key: 'id',
    lines: [{ table: 'stock_count_items', parentKey: 'count_id' }],
  },
  {
    table: 'stock_entries',
    key: 'id',
    lines: [{ table: 'stock_entry_items', parentKey: 'entry_id' }],
  },
  { table: 'stock_ledger', key: 'id', lines: [] },
  { table: 'suppliers', key: 'id', lines: [] },
  { table: 'users', key: 'id', lines: [] },
]

const BY_TABLE = new Map(REPLICATED.map((r) => [r.table, r]))

export function shapeOf(table: string): RecordShape | undefined {
  return BY_TABLE.get(table)
}

/**
 * Tables that are deliberately not replicated, with the reason kept beside the
 * name so that "why is this not syncing" has an answer that is not a guess.
 */
export const NOT_REPLICATED: Readonly<Record<string, string>> = {
  product_stock: 'derived from stock_ledger; a merge recomputes it',
  doc_sequences: 'a number series. Taking either side would hand two tills the same invoice number',
  audit_log: 'this machine\'s own history. Worth showing one day, but it has no conflict to resolve',
  activity_log: 'the same, and read by nothing yet',
  change_feed: 'what this machine still has to send',
  sync_state: 'whether a merge is running right now',
  sync_peers: 'who this machine has paired with, and how far each has read',
  sync_queue: 'reserved on day one and never used. See docs/multi-device.md',
}

/** One record as it crosses between two tills. */
export interface ChangeRecord {
  table: string
  rowId: string
  op: 'upsert' | 'delete'
  /** Null for a delete, and for a row that vanished before it could be read. */
  row: Row | null
  /** Its lines, by table. Absent for a record that has none. */
  lines?: Record<string, Row[]>
}

/** A batch of records, and how far through the sender's feed it reaches. */
export interface ChangeBatch {
  /** The sending machine, so the receiver can attribute and tiebreak. */
  fromDevice: string | null
  /** The sender's schema version. A mismatch refuses before any row moves. */
  schemaVersion: number
  records: ChangeRecord[]
  /** The feed seq of the last record here. The receiver's next cursor. */
  upTo: number
  /** False when there is more waiting behind this batch. */
  complete: boolean
}
