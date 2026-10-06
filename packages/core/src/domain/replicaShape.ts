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

/**
 * A row as it travels: column name to value.
 *
 * The same shape as the driver's `Row`, spelled out here rather than imported,
 * because the domain describes records and never touches the database that
 * holds them. The two are structurally one type, so either is accepted where
 * the other is asked for.
 */
type Row = Record<string, string | number | bigint | Uint8Array | null>

export interface RecordShape {
  table: string
  /** The column the row is identified by. `settings` is keyed by its name. */
  key: string
  /** Tables holding this record's lines, and the column pointing back here. */
  lines: ReadonlyArray<{ table: string; parentKey: string }>
  /**
   * When only some of this table's rows travel, the condition the ones that do
   * satisfy — as SQL, because the two places that need it are a trigger and an
   * `INSERT … SELECT`.
   *
   * Absent for every table but two -- bills (042) and returns (057) -- and that is the point of it being here
   * rather than a name checked against in a loop somewhere: the rule is a
   * replication decision, and this file is where replication decisions are
   * written down once instead of three times.
   */
  travels?: string
  /**
   * Columns that say when a machine wrote the row rather than what the row
   * says. Two copies that differ only in these are one row, and arriving is
   * not an edit. Only `gl_entries`, whose ids two tills can derive alike.
   */
  incidental?: readonly string[]
}

/**
 * Every table whose rows travel on their own, **in dependency order**.
 *
 * The order is load-bearing, not tidiness. A batch is applied in the order it
 * arrives, so a `users` row landing before the `roles` row it points at fails on
 * a foreign key — and since the whole batch is one transaction, that one row
 * fails the entire sync, identically, every time, for ever.
 *
 * That is not hypothetical. It is exactly what happened the first time two real
 * tills were pointed at each other: `FOREIGN KEY constraint failed` on the first
 * user. The in-process tests had not caught it because they synced twice and the
 * second round happened to pick up what the first had dropped — a workaround
 * written into a test, which is the most expensive kind of green.
 *
 * `replicaShape.test.ts` now checks this order against the schema's own foreign
 * keys, so it cannot quietly stop being true when a table is added.
 *
 * `stock_ledger` carries no `rev` and does not need one: it is append-only --
 * the database refuses an edit or a delete since 052 -- so two tills cannot
 * disagree about a row, only each be missing some of the other's, which is a
 * union rather than a merge. `loyalty_entries` was once listed here too, and
 * wrongly: its `consumed`, `points` and `cancelled_at` are edited, so since 051
 * it carries a `rev` and merges like any other edited record, with
 * `reconcileLoyalty` putting `consumed` back in line after each merge.
 */
export const REPLICATED: readonly RecordShape[] = [
  { table: 'settings', key: 'key', lines: [] },
  {
    table: 'roles',
    key: 'id',
    lines: [
      { table: 'role_pages', parentKey: 'role_id' },
      { table: 'role_permissions', parentKey: 'role_id' },
    ],
  },
  { table: 'categories', key: 'id', lines: [] },
  { table: 'price_lists', key: 'id', lines: [] },
  { table: 'suppliers', key: 'id', lines: [] },
  { table: 'doc_formats', key: 'id', lines: [] },
  { table: 'registers', key: 'id', lines: [] },
  { table: 'users', key: 'id', lines: [] },
  { table: 'user_sessions', key: 'id', lines: [] },
  { table: 'products', key: 'id', lines: [] },
  { table: 'product_barcodes', key: 'id', lines: [] },
  { table: 'product_units', key: 'id', lines: [] },
  { table: 'batches', key: 'id', lines: [] },
  { table: 'customers', key: 'id', lines: [] },
  { table: 'item_prices', key: 'id', lines: [] },
  { table: 'customer_item_prices', key: 'id', lines: [] },
  {
    table: 'cash_sessions',
    key: 'id',
    lines: [{ table: 'cash_movements', parentKey: 'session_id' }],
  },
  {
    table: 'documents',
    key: 'id',
    lines: [{ table: 'document_items', parentKey: 'document_id' }],
  },
  {
    table: 'bills',
    key: 'id',
    /* A draft is a cashier mid-sale. It is invisible on arrival — `listOpenDrafts`
       filters by register and a counter belongs to one till — and it was costing
       a round of traffic per keystroke on every edge in the shop. Migration 042
       carries the argument. */
    travels: 'docstatus <> 0',
    lines: [
      { table: 'bill_items', parentKey: 'bill_id' },
      { table: 'bill_payments', parentKey: 'bill_id' },
      { table: 'bill_fulfilments', parentKey: 'bill_id' },
      { table: 'loyalty_redemptions', parentKey: 'bill_id' },
    ],
  },
  {
    table: 'payment_entries',
    key: 'id',
    lines: [{ table: 'payment_allocations', parentKey: 'payment_id' }],
  },
  {
    table: 'sales_returns',
    key: 'id',
    /* A draft return is a person mid-refund, as a draft bill is a cashier
       mid-sale; it stays where it is being made. Migration 057. */
    travels: 'docstatus <> 0',
    lines: [{ table: 'sales_return_items', parentKey: 'return_id' }],
  },
  {
    table: 'stock_entries',
    key: 'id',
    lines: [
      { table: 'stock_entry_items', parentKey: 'entry_id' },
      { table: 'stock_entry_batches', parentKey: 'entry_id' },
    ],
  },
  {
    table: 'stock_counts',
    key: 'id',
    lines: [{ table: 'stock_count_items', parentKey: 'count_id' }],
  },
  { table: 'stock_ledger', key: 'id', lines: [] },
  /* Append-only and travelling on its own, for the ledger's reasons: a
     merge of the bill a movement belongs to must not be able to lose it. */
  { table: 'batch_movements', key: 'id', lines: [] },
  /* The general ledger (064), append-only for the same reasons. Its ids are
     derived from the document, so two tills that both post one document write
     the same rows and the union is still a union -- the same but for when
     each was written, which is not a disagreement. */
  { table: 'gl_entries', key: 'id', lines: [], incidental: ['created_at'] },
  { table: 'loyalty_entries', key: 'id', lines: [] },
  /* Its own row, like the ledger: written once when a line is converted,
     and never lost to a merge of the document it marks (054). */
  { table: 'document_fulfilments', key: 'id', lines: [] },
  { table: 'attachments', key: 'id', lines: [] },
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
  change_feed: 'what this machine still has to send',
  sync_state: 'whether a merge is running right now, and how far this machine has pruned its feed and filled in its books',
  sync_peers: 'who this machine has paired with, and how far each has read',
  sync_conflicts: 'where this machine dropped somebody\'s edit. The other till has its own view',
  sync_quarantine: 'a record this machine could not apply. The till that sent it applied it fine',
  discrepancies_seen: 'which discrepancies somebody at this till has been told about. The other till tells its own people',
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
