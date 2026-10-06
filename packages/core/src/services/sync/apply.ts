import type { SqlDriver } from '../../db/driver.js'
import { MERGE_BUDGET_MS } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import { type ChangeBatch, type ChangeRecord } from '../../domain/replicaShape.js'
import { applyingRemote } from '../changefeed.js'
import { recomputeStock } from '../stock.js'
import { reconcileLoyalty } from '../loyaltyLedger.js'
import { reconcileReturnedQty } from '../returns/reconcile.js'
import { reconcileFulfilledQty } from '../documents/reconcile.js'
import { clock } from '../../clock.js'
import { applyRecord } from './record.js'
import {
  RECORD, anythingSetAside, keyOf, orphansAmong, parentSetAside, retrySetAside,
} from './setAside.js'
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
  /* An empty batch still has work when something is set aside. The fix a
     person is told to make for a name that clashes -- rename one, then sync
     again -- is a local edit, and the round after it usually brings nothing
     in. Without this the record they were waiting on would wait for the next
     round that happened to carry a row. */
  if (batch.records.length === 0 && !await anythingSetAside(db)) {
    return { applied: 0, contested: [], ignoredColumns: 0, ignoredTables: 0, quarantined: 0, cachesHeld: 0 }
  }

  const cancelledNow = await returnsCancelledBy(db, batch)
  const { recovered, ...outcome } = await mergeBatch(db, batch, changedHereToo)
  /* The caches below are scoped by what arrived, and a record that has just
     come out of quarantine arrived as surely as anything in the batch. */
  const arrived = recovered.length === 0 ? batch.records : [...batch.records, ...recovered]

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
    const touched = productsIn(arrived)
    if (touched === null || touched.length > 0) {
      await recomputeStock(db, { repair: true, ...(touched ? { productIds: touched } : {}) })
    }
    /* The same for points: what an entry has had spent from it is a cache of
       the redemptions, which arrive inside their bill. See `loyaltyLedger.ts`. */
    const customers = idsIn(arrived, LOYALTY_SOURCES, (r) => r.row?.['customer_id'])
    if (customers === null || customers.length > 0) {
      const found = await reconcileLoyalty(db, { repair: true, customerIds: customers })
      outcome.cachesHeld += found.filter((d) => !d.repairable).length
    }
    /* And what each bill line has had back, which two partial returns of one
       bill on two tills would otherwise leave one increment short. */
    const bills = idsIn(arrived, RETURN_SOURCES, (r) => (r.table === 'bills' ? r.rowId : r.row?.['bill_id']))
    if (bills === null || bills.length > 0) {
      const found = await reconcileReturnedQty(db, { repair: true, billIds: bills, cancelledNow })
      outcome.cachesHeld += found.filter((d) => !d.repairable).length
    }
    /* And what each order line has been fulfilled by -- bills against it and
       conversions of it, both recorded row by row. */
    const documents = idsIn(arrived, FULFIL_SOURCES, (r) => (
      r.table === 'documents' ? r.rowId
        : r.table === 'bills' ? r.row?.['converted_from']
          : r.row?.['document_id']))
    if (documents === null || documents.length > 0) {
      const found = await reconcileFulfilledQty(db, { repair: true, documentIds: documents })
      outcome.cachesHeld += found.filter((d) => !d.repairable).length
    }
    /* Not the books. A document's entries travel behind it as rows of their
       own, and working them out here -- as 0.2.0 did -- races them: a till
       joining a shop is sent its bills a batch before their stock movements,
       posts them without a cost, and then refuses the real entries under the
       same ids. No till able to sync lacks a ledger (the floor is above 064),
       so there is nothing here for this to fill in. See `fillLedgerOnce`. */
  }

  return outcome
}

/**
 * Returns this batch cancels: cancelled in the batch, and not already
 * cancelled here. Read before the merge, because after it the two look alike
 * -- and a cancellation seen twice must not take its quantity off twice.
 * See `reconcileReturnedQty`.
 */
async function returnsCancelledBy(db: SqlDriver, batch: ChangeBatch): Promise<string[]> {
  const ids = batch.records
    .filter((r) => r.table === 'sales_returns' && r.op === 'upsert' && r.row?.['docstatus'] === 2)
    .map((r) => r.rowId)
  if (ids.length === 0) return []
  // raw: an IN list as long as the batch's cancellations, which is short.
  const already = await db.query<{ id: string }>(
    `SELECT id FROM sales_returns WHERE docstatus = 2 AND id IN (${ids.map(() => '?').join(', ')})`, ids)
  const held = new Set(already.map((r) => r.id))
  return ids.filter((id) => !held.has(id))
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
function productsIn(records: readonly ChangeRecord[]): string[] | null {
  const ids = new Set<string>()
  for (const record of records) {
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
  records: readonly ChangeRecord[],
  tables: ReadonlySet<string>,
  pick: (record: ChangeRecord) => unknown,
): string[] | null {
  const ids = new Set<string>()
  for (const record of records) {
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

/** A merge's outcome, and the parked records that landed during it. */
type BatchOutcome = MergeOutcome & { recovered: ChangeRecord[] }

/**
 * Records that point at a row this database does not hold, found before the
 * COMMIT that would have refused them.
 *
 * Thrown from the slow pass so that the pass can be run again with these set
 * aside from the start. Keyed like `setAside`; the value is the reason.
 */
class Orphaned extends Error {
  constructor(readonly waiting: ReadonlyMap<string, string>) {
    super(`${waiting.size} record(s) point at rows that are not here`)
    this.name = 'Orphaned'
  }
}

async function mergeBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
): Promise<BatchOutcome> {
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
      db, (tx) => runBatch(tx, batch, changedHereToo, false, NONE_WAITING), { budgetMs: MERGE_BUDGET_MS },
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
       cursor stays where it was, and the round is reported as failed.

       With one exception, which is a diagnosis and not a guess: a record whose
       parent is not here. A savepoint cannot catch that, because the foreign
       key is deferred and only checked at COMMIT -- and the parent can
       legitimately be in a *later* batch, because the feed is a set and editing
       a category after adding a product to it moves the category's entry
       behind the product's. Without this the COMMIT failed on both passes,
       nothing was set aside, the cursor stayed put, and the next round built
       the identical batch: a pair of tills wedged for good. So the slow pass
       asks SQLite before committing, and when it names records that point at
       nothing it is run again with those set aside. Each run sets aside at
       least one more record, so this ends. */
    const waiting = new Map<string, string>()
    for (;;) {
      try {
        return await applyingRemote(
          db, (tx) => runBatch(tx, batch, changedHereToo, true, waiting), { budgetMs: MERGE_BUDGET_MS },
        )
      } catch (err) {
        if (!(err instanceof Orphaned)) throw err
        const before = waiting.size
        for (const [key, why] of err.waiting) waiting.set(key, why)
        if (waiting.size === before) throw err
      }
    }
  }
}

const NONE_WAITING: ReadonlyMap<string, string> = new Map()



async function runBatch(
  tx: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
  /** Whether to put a savepoint around each record. See `mergeBatch`. */
  oneByOne: boolean,
  /** Records an earlier run of this pass found pointing at nothing. */
  waiting: ReadonlyMap<string, string>,
): Promise<BatchOutcome> {
  let applied = 0
  let ignoredColumns = 0
  let ignoredTables = 0
  let quarantined = 0
  const contested: ContestedChange[] = []
  const setAside = new Set<string>()
  /* What this run wrote, so the check before COMMIT can tell an orphan this
     batch made from one that was already here. */
  const landed: ChangeRecord[] = []

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

    /* Found pointing at nothing by an earlier run of this pass. Set aside
       rather than tried again, because trying again only fails at COMMIT. It
       comes back out on its own once what it waits for has arrived -- see
       `retrySetAside`. */
    const key = keyOf(record.table, record.rowId)
    const waitingFor = waiting.get(key)
    /* A record whose parent was set aside cannot land either, and finding that
       out at COMMIT fails the whole batch — which is the thing this pass exists
       to prevent. `REPLICATED`'s dependency order covers most of it and cannot
       cover a row that points at its own table: `categories.parent_id`,
       `bills.amended_from`, `products.parent_product_id`. */
    const orphaned = waitingFor ?? await parentSetAside(tx, record, setAside)
    if (orphaned !== null) {
      await quarantine(tx, batch, record, orphaned)
      setAside.add(key)
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
      if (outcome.applied > 0) landed.push(record)
    } catch (err) {
      /* Both statements, and in this order. `ROLLBACK TO` undoes the work and
         leaves the savepoint on the stack; without the `RELEASE` the stack grows
         by one for every record that fails. */
      await tx.execute(`ROLLBACK TO ${RECORD}`)
      await tx.execute(`RELEASE ${RECORD}`)
      await quarantine(tx, batch, record, reasonOf(err))
      setAside.add(key)
      quarantined += 1
    }
  }

  /* After the batch, because the batch is usually what a parked record was
     waiting for: the category behind the product, the counter renamed on the
     other till. */
  const retried = await retrySetAside(tx, setAside, waiting)
  applied += retried.recovered.length

  /* The last thing before COMMIT on the slow pass: would it be refused? Only
     here, because a healthy merge never reaches the slow pass, and on this one
     the cost of asking is a scan of the tables the batch touched against the
     cost of a shop that stops replicating. */
  if (oneByOne) {
    const orphans = await orphansAmong(tx, [...landed, ...retried.recovered])
    if (orphans.size > 0) throw new Orphaned(orphans)
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

  return {
    applied, contested, ignoredColumns, ignoredTables, quarantined, cachesHeld: 0,
    recovered: retried.recovered,
  }
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
