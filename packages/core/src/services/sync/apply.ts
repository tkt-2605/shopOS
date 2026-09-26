import type { SqlDriver } from '../../db/driver.js'
import { MERGE_BUDGET_MS } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import { shapeOf, type ChangeBatch, type ChangeRecord } from '../../domain/replicaShape.js'
import { applyingRemote } from '../changefeed.js'
import { recomputeStock } from '../stock.js'
import { reconcileLoyalty } from '../loyaltyLedger.js'
import { reconcileReturnedQty } from '../returns/reconcile.js'
import { reconcileFulfilledQty } from '../documents/reconcile.js'
import { clock } from '../../clock.js'
import { applyRecord } from './record.js'
import type { ContestedChange } from './types.js'

/*
 * Taking a batch in: one transaction for the whole of it, and a second pass
 * with a savepoint per record when something in it will not land -- that one is
 * set aside rather than allowed to stop everything behind it.
 */

export interface MergeOutcome {
  applied: number
  contested: ContestedChange[]
  /** See `SyncResult.ignoredColumns`. */
  ignoredColumns: number
  ignoredTables: number
  /**
   * Records that could not be applied and were set aside rather than allowed to
   * stop the batch. See migration 038 and `sync_quarantine`.
   *
   * Reported rather than counted quietly, because the cursor moves past them:
   * the sending till will prune its own entry, and after that the only record
   * that this row ever existed is the one here.
   */
  quarantined: number
  /**
   * Differences between a cache and its records that the post-merge repair
   * found and deliberately left, because correcting them the other way could
   * hand a customer points or a refund the shop did not give. See
   * `loyaltyLedger.ts` and `returns/reconcile.ts`. Nothing is wrong yet; a
   * number that stays above zero round after round is worth a person's look.
   */
  cachesHeld: number
}

/** Records whose arrival can leave a loyalty entry's cache behind. */
const LOYALTY_SOURCES: ReadonlySet<string> = new Set(['loyalty_entries', 'loyalty_redemptions', 'bills'])
/** Records whose arrival can leave a bill line's returned quantity behind. */
const RETURN_SOURCES: ReadonlySet<string> = new Set(['bills', 'sales_returns'])
/** Records whose arrival can leave an order line's fulfilled quantity behind. */
const FULFIL_SOURCES: ReadonlySet<string> = new Set(['documents', 'document_fulfilments', 'bills'])

/**
 * Applies a batch, deciding each record against what is already here.
 *
 * Everything happens inside `applyingRemote`, so none of it is fed back to the
 * till it came from and none of it raises a revision. Both matter: a revision
 * raised here would make this copy look newer than the machine that wrote it,
 * and the next round would send it straight back as an edit nobody made.
 */
export async function applyBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string> = new Set(),
): Promise<MergeOutcome> {
  if (batch.records.length === 0) {
    return { applied: 0, contested: [], ignoredColumns: 0, ignoredTables: 0, quarantined: 0, cachesHeld: 0 }
  }

  const outcome = await mergeBatch(db, batch, changedHereToo)

  /* `product_stock` is a cache of the ledger and does not replicate — and
     `NOT_REPLICATED` has said "a merge recomputes it" since the day it was
     written, while nothing did. So a till that took in another till's sales had
     stale stock figures until somebody happened to open Inventory, and the two
     tills quietly disagreed about what was on the shelf.

     This is also the whole of the oversell case. Two tills each sell the last
     one: each is at zero and neither is wrong on its own, and only after the
     ledgers are put together is the shop one short. Nothing recomputed, so
     nothing went below zero, so "Counts that need fixing" stayed empty and
     nobody was ever told.

     Only the products whose ledger rows actually arrived, and after the merge
     rather than inside it, so a busy counter is not held behind a long
     transaction. A recompute that is missed is picked up by the next sync or by
     the weekly replay; a counter that stalls mid-sale is not recoverable in the
     same way.

     Scoped since Phase 3. This used to replay the whole ledger — every product
     in the shop, forty-seven thousand movements on a year of trade, because one
     row for one item came across. */
  if (outcome.applied > 0) {
    const touched = productsIn(batch)
    if (touched === null || touched.length > 0) {
      await recomputeStock(db, { repair: true, ...(touched ? { productIds: touched } : {}) })
    }
    /* The same for points: what an entry has had spent from it is a cache of
       the redemptions, which arrive inside their bill. See `loyaltyLedger.ts`. */
    const customers = idsIn(batch, LOYALTY_SOURCES, (r) => r.row?.['customer_id'])
    if (customers === null || customers.length > 0) {
      const found = await reconcileLoyalty(db, { repair: true, customerIds: customers })
      outcome.cachesHeld += found.filter((d) => !d.repairable).length
    }
    /* And what each bill line has had back, which two partial returns of one
       bill on two tills would otherwise leave one increment short. */
    const bills = idsIn(batch, RETURN_SOURCES, (r) => (r.table === 'bills' ? r.rowId : r.row?.['bill_id']))
    if (bills === null || bills.length > 0) {
      const found = await reconcileReturnedQty(db, { repair: true, billIds: bills })
      outcome.cachesHeld += found.filter((d) => !d.repairable).length
    }
    /* And what each order line has been fulfilled by -- bills against it and
       conversions of it, both recorded row by row. */
    const documents = idsIn(batch, FULFIL_SOURCES, (r) => (
      r.table === 'documents' ? r.rowId
        : r.table === 'bills' ? r.row?.['converted_from']
          : r.row?.['document_id']))
    if (documents === null || documents.length > 0) {
      const found = await reconcileFulfilledQty(db, { repair: true, documentIds: documents })
      outcome.cachesHeld += found.filter((d) => !d.repairable).length
    }
  }

  return outcome
}

/**
 * Which products a batch has something to say about, or null for "cannot tell".
 *
 * A deletion carries no row, so there is no way to learn from the batch alone
 * which product the deleted movement belonged to. That answers null and the
 * caller replays everything, which is slow and correct — and the alternative,
 * guessing, leaves one product's cache wrong with nothing to notice it until
 * the weekly replay. Deletions of ledger rows are refused outright (052), so
 * this is reached only by a row that vanished before it could be read.
 */
function productsIn(batch: ChangeBatch): string[] | null {
  const ids = new Set<string>()
  for (const record of batch.records) {
    if (record.table !== 'stock_ledger') continue
    /* A deletion of a movement is refused by the database since 052 and
       quarantined, so it changes nothing here to replay. */
    if (record.op === 'delete') continue
    const id = record.row?.['product_id']
    if (typeof id !== 'string') return null
    ids.add(id)
  }
  return [...ids]
}

/**
 * The ids a batch names for one purpose, or null for "cannot tell" -- a
 * deletion in one of the tables carries no row to read them from, and the
 * caller then looks at everything, which is slow and correct.
 */
function idsIn(
  batch: ChangeBatch,
  tables: ReadonlySet<string>,
  pick: (record: ChangeBatch['records'][number]) => unknown,
): string[] | null {
  const ids = new Set<string>()
  for (const record of batch.records) {
    if (!tables.has(record.table)) continue
    const id = pick(record)
    if (typeof id !== 'string') {
      if (record.row === null) return null
      continue
    }
    ids.add(id)
  }
  return [...ids]
}

async function mergeBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
): Promise<MergeOutcome> {
  /* Ninety seconds rather than a bill's fifteen.
   *
   * The whole batch is one transaction on purpose: half a merge is not a state
   * any reconciliation rule can describe. On a till that has been offline a week
   * that can legitimately take a minute, and under a bill's budget the watchdog
   * rolls it back — so the next round starts again from the beginning, takes
   * just as long, and is rolled back again. A till far enough behind would never
   * catch up, and nobody would diagnose that from the shop floor. */
  try {
    return await applyingRemote(
      db, (tx) => runBatch(tx, batch, changedHereToo, false), { budgetMs: MERGE_BUDGET_MS },
    )
  } catch {
    /* Something in this batch will not go in, and the fast path has just rolled
       back everything including everything that was fine. So it runs again, with
       a savepoint around each record, and the one that cannot land is set aside
       instead of taking the batch with it.

       A second pass rather than savepoints every time, because the cost is two
       statements per record on a path that already does four or five — paid on
       every healthy merge to insure against a rare one. This way a shop that
       never meets the case never pays for it, and a shop that does pays once.

       Not retried beyond this. If the slow path throws as well then the fault is
       not a record — it is the disk, the schema, or the watchdog — and setting a
       whole batch aside would be inventing a diagnosis. The throw goes up, the
       cursor stays where it was, and the round is reported as failed. */
    return await applyingRemote(
      db, (tx) => runBatch(tx, batch, changedHereToo, true), { budgetMs: MERGE_BUDGET_MS },
    )
  }
}

/**
 * The savepoint's name.
 *
 * One constant rather than one per record: `run_execute` in the Rust driver
 * prepares statements into a small cache, and a fresh name each time would push
 * out the statements the merge actually runs on. SQLite is content to reuse a
 * name — `ROLLBACK TO` and `RELEASE` find the most recent one that carries it.
 */
const RECORD = 'shopos_record'

async function runBatch(
  tx: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
  /** Whether to put a savepoint around each record. See `mergeBatch`. */
  oneByOne: boolean,
): Promise<MergeOutcome> {
  let applied = 0
  let ignoredColumns = 0
  let ignoredTables = 0
  let quarantined = 0
  const contested: ContestedChange[] = []
  const setAside = new Set<string>()

  /* Foreign keys are checked at COMMIT rather than per statement, for the rows
     written inside this transaction only.

     `REPLICATED` is in dependency order and the feed is seeded in that order,
     so a batch normally arrives parents-first anyway. This is the safety net
     for the cases that ordering cannot cover: a row whose parent changed in
     the same batch and sorted after it, and `bills.amended_from`, which points
     at another bill. Without it one such row fails the whole batch — every
     time, in the same way, for ever. The check still happens; it happens once,
     at the end, when the batch is whole.

     It survives a savepoint rollback. SQLite clears the flag on a full rollback
     and on a successful commit and on neither of the two statements below, and
     it restores the count of outstanding violations to what it was when the
     savepoint opened — so a record that is set aside takes its own dangling
     references with it rather than leaving them to fail the COMMIT. */
  await tx.execute(`PRAGMA defer_foreign_keys = ON`)

  for (const record of batch.records) {
    if (!oneByOne) {
      const outcome = await applyRecord(tx, record, batch, changedHereToo)
      applied += outcome.applied
      ignoredColumns += outcome.ignoredColumns
      ignoredTables += outcome.ignoredTables
      contested.push(...outcome.contested)
      continue
    }

    /* A record whose parent was set aside cannot land either, and finding that
       out at COMMIT fails the whole batch — which is the thing this pass exists
       to prevent. `REPLICATED`'s dependency order covers most of it and cannot
       cover a row that points at its own table: `categories.parent_id`,
       `bills.amended_from`, `products.parent_product_id`. */
    const orphaned = await parentSetAside(tx, record, setAside)
    if (orphaned !== null) {
      await quarantine(tx, batch, record, orphaned)
      setAside.add(`${record.table}\u0000${record.rowId}`)
      quarantined += 1
      continue
    }

    await tx.execute(`SAVEPOINT ${RECORD}`)
    try {
      const outcome = await applyRecord(tx, record, batch, changedHereToo)
      await tx.execute(`RELEASE ${RECORD}`)
      applied += outcome.applied
      ignoredColumns += outcome.ignoredColumns
      ignoredTables += outcome.ignoredTables
      contested.push(...outcome.contested)
    } catch (err) {
      /* Both statements, and in this order. `ROLLBACK TO` undoes the work and
         leaves the savepoint on the stack; without the `RELEASE` the stack grows
         by one for every record that fails. */
      await tx.execute(`ROLLBACK TO ${RECORD}`)
      await tx.execute(`RELEASE ${RECORD}`)
      await quarantine(tx, batch, record, reasonOf(err))
      setAside.add(`${record.table}\u0000${record.rowId}`)
      quarantined += 1
    }
  }

  /* Written inside the same transaction that applied the batch, so a merge
     that rolls back cannot leave a complaint about a change it did not make.

     This matters more once the catch-up runs on its own: up to here a person
     was watching the answer, and from here nobody is. A dropped edit that is
     only ever returned from a function is a dropped edit nobody hears about. */
  for (const complaint of contested) {
    await q(tx).insert(schema.syncConflicts).values({
      id: newId(),
      at: clock.iso(),
      peerDevice: batch.fromDevice,
      tableName: complaint.table,
      rowId: complaint.rowId,
      winner: complaint.winner,
      explain: complaint.explain,
    })
  }

  return { applied, contested, ignoredColumns, ignoredTables, quarantined, cachesHeld: 0 }
}

/**
 * Sets a record aside, with the reason and the record itself.
 *
 * Written after the `ROLLBACK TO`, so it belongs to the outer transaction and
 * survives the undo of the thing it describes. Migration 038 carries why it
 * keeps a payload where the changefeed refuses to: this is the only copy of that
 * row this database will ever hold, because the cursor is about to step past it.
 */
async function quarantine(
  tx: SqlDriver,
  batch: ChangeBatch,
  record: ChangeRecord,
  reason: string,
): Promise<void> {
  const at = clock.iso()
  const stored = JSON.stringify(record)
  await q(tx).insert(schema.syncQuarantine)
    .values({
      id: newId(),
      at,
      peerDevice: batch.fromDevice,
      tableName: record.table,
      rowId: record.rowId,
      op: record.op,
      reason,
      record: stored,
    })
    .onConflictDoUpdate({
      /* One entry per record. A row that fails again is the same complaint with
         a fresher date on it, not a second one — and `acknowledged` goes back to
         zero, because somebody having seen it last week is not the same as
         somebody having seen this. */
      target: [schema.syncQuarantine.tableName, schema.syncQuarantine.rowId],
      set: {
        at,
        peerDevice: batch.fromDevice,
        op: record.op,
        reason,
        record: stored,
        acknowledged: 0,
      },
    })
}

/**
 * Which foreign keys a table has, asked once per table per process.
 *
 * Cached on the driver rather than globally for `localColumns`' reason: a test
 * that opens two databases in one process must not be handed the other's shape.
 */
const keysOf = new WeakMap<SqlDriver, Map<string, Array<{ from: string; table: string }>>>()

async function foreignKeys(
  tx: SqlDriver, table: string,
): Promise<Array<{ from: string; table: string }>> {
  let tables = keysOf.get(tx)
  if (!tables) { tables = new Map(); keysOf.set(tx, tables) }

  const cached = tables.get(table)
  if (cached !== undefined) return cached

  /* raw: a PRAGMA, which a query builder has no words for. The name is
     `REPLICATED`'s and never the wire's -- see the note on `upsert` in `record.ts`. */
  const rows = await tx.query<{ from: string; table: string }>(
    `PRAGMA foreign_key_list("${table}")`,
  )
  const keys = rows.map((r) => ({ from: r.from, table: r.table }))
  tables.set(table, keys)
  return keys
}

/** Why a record cannot land when what it points at did not, or null. */
async function parentSetAside(
  tx: SqlDriver,
  record: ChangeRecord,
  setAside: ReadonlySet<string>,
): Promise<string | null> {
  if (setAside.size === 0 || record.row === null) return null
  const shape = shapeOf(record.table)
  if (shape === undefined) return null

  for (const key of await foreignKeys(tx, shape.table)) {
    const value = record.row[key.from]
    if (typeof value !== 'string') continue
    if (setAside.has(`${key.table}\u0000${value}`)) {
      return `parent quarantined: ${key.table} ${value}`
    }
  }
  return null
}

/** What SQLite said, got back out as plainly as it can be. */
function reasonOf(err: unknown): string {
  let said = String(err)
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    said = cause instanceof Error && cause.message !== '' ? cause.message : err.message
  }
  return sameNameOnBoth(said) ?? said
}

/** What a natural key is called on a screen, by `table.column`. */
const NAMED: Readonly<Record<string, string>> = {
  'products.code': 'an item with the same code',
  'customers.code': 'a customer with the same code',
  'price_lists.name': 'a price list with the same name',
  'roles.name': 'a role with the same name',
  'users.username': 'a staff login with the same username',
  'registers.name': 'a counter with the same name',
  'registers.prefix': 'a counter with the same bill prefix',
}

/**
 * The one refusal a person can fix, said so they can.
 *
 * Two tills apart can each create a thing under the same name -- a counter
 * called "Counter 2", a login "ravi" -- as two rows with two ids. The second
 * to arrive breaks the UNIQUE and is set aside, and everything pointing at it
 * after it. SQLite's words for that name a column; these name the fix.
 */
function sameNameOnBoth(said: string): string | null {
  const clash = /UNIQUE constraint failed: (\w+\.\w+)/.exec(said)
  const what = clash ? NAMED[clash[1]!] : undefined
  if (!what) return null
  return `The other till made ${what} while the two were apart. Rename or remove one of them, `
    + `then sync again. (${said})`
}
