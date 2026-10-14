import { inArray } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { clock } from '../clock.js'
import {
  refundedTwice, refundedAndCancelled, paidTwice, advanceSpentTwice, pointsSpentTwice, correctedTwice, supplierOverpaid,
  orderBilledTwice, soldBelowZero, overCreditLimit, figuresLeft, theBooks, syncLeftovers,
} from './discrepancies/checks.js'
import type { Discrepancy } from './discrepancies/types.js'

export type { Discrepancy, DiscrepancyKind } from './discrepancies/types.js'

/*
 * Everything in the shop's records that does not add up, in one list.
 *
 * Several tills that cannot always reach each other will sometimes each do
 * something that is right on its own and wrong together: refund the same item,
 * bill the same order, sell the last one, give credit up to the limit. No
 * counter can refuse what it cannot know about, so the shop is told after the
 * tills have synced instead. Before this list, each of those was a number in a
 * log at best -- the merge counted what it left alone and nobody read it.
 *
 * Read only. The checks are in `discrepancies/checks.ts`, one per kind.
 */

/** The money and stock first: what a shopkeeper would want to hear about first. */
const ORDER: Record<Discrepancy['area'], number> = { money: 0, stock: 1, books: 2, records: 3, sync: 4 }

/** Everything that does not add up right now, seen or not. */
export async function findDiscrepancies(db: SqlDriver): Promise<Discrepancy[]> {
  const found: Discrepancy[] = []
  for (const check of [refundedTwice, refundedAndCancelled, paidTwice, advanceSpentTwice, pointsSpentTwice, correctedTwice, supplierOverpaid, orderBilledTwice, soldBelowZero, overCreditLimit, figuresLeft, theBooks, syncLeftovers]) {
    found.push(...await check(db))
  }
  return found.sort((a, b) => ORDER[a.area] - ORDER[b.area] || (b.at ?? '').localeCompare(a.at ?? ''))
}

/** Each discrepancy with whether somebody on this till has marked it seen. */
export async function discrepanciesWithSeen(db: SqlDriver): Promise<(Discrepancy & { seen: boolean })[]> {
  const found = await findDiscrepancies(db)
  if (found.length === 0) return []
  const seen = await q(db)
    .select({ key: schema.discrepanciesSeen.key })
    .from(schema.discrepanciesSeen)
    .where(inArray(schema.discrepanciesSeen.key, found.map((d) => d.key)))
  const known = new Set(seen.map((s) => s.key))
  return found.map((d) => ({ ...d, seen: known.has(d.key) }))
}

/** Marks discrepancies seen on this till, by key. Seen once is seen until the facts change. */
export async function markDiscrepanciesSeen(
  db: SqlDriver,
  input: { keys: readonly string[]; actorId: string | null },
): Promise<void> {
  if (input.keys.length === 0) return
  const at = clock.iso()
  for (const key of input.keys) {
    await q(db).insert(schema.discrepanciesSeen)
      .values({ key, seenAt: at, seenBy: input.actorId })
      .onConflictDoNothing()
  }
}
