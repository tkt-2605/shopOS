import { eq, and, gt, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, ZERO, sub } from '../../money.js'
import { totalOutstanding, type OpenBill } from '../../domain/credit.js'
import { SUBMITTED } from '../../integrity/docstatus.js'

/*
 * What is owed: bill by bill for one customer, and across the whole shop.
 */

/**
 * What submitted payments have allocated to the bill in the outer query.
 *
 * raw: a correlated subquery, which the query builder has no shape for.
 * Joining to the allocations instead would repeat the bill row once per
 * payment against it, so a bill settled in instalments would count its own
 * credit total once per instalment. `bills.id` is written out rather than
 * interpolated because Drizzle renders a column reference unqualified inside
 * a subquery, where a bare `id` binds to the allocation tables first.
 *
 * One definition, used by billing, payments and returns alike: it had been
 * written out three times, which is three places for "allocated" to start
 * meaning three different things.
 */
export const ALLOCATED_TO_BILL = sql<Money>`COALESCE((
  SELECT SUM(pa.amount) FROM payment_allocations pa
    JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = ${SUBMITTED}
   WHERE pa.bill_id = bills.id), 0)`

export async function loadOpenBills(db: SqlDriver, customerId: string): Promise<OpenBill[]> {
  const allocated = ALLOCATED_TO_BILL
  return q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      postingDate: schema.bills.postingDate,
      creditTotal: schema.bills.creditTotal,
      allocated,
    })
    .from(schema.bills)
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
      gt(schema.bills.creditTotal, ZERO),
    ))
}

export async function customerOutstanding(db: SqlDriver, customerId: string): Promise<Money> {
  return totalOutstanding(await loadOpenBills(db, customerId))
}

export interface OutstandingTotal {
  /** What the shop is owed, across every customer there is. */
  total: Money
  /** How many customers that is spread over. */
  customers: number
  /** The one to start with on a collection day, or null if nobody owes. */
  worst: { id: string; name: string; outstanding: Money } | null
  /** How many are past a limit they were given. Customers with no limit set
      cannot be over it, and are not counted. */
  overLimit: number
}

/**
 * What the shop is owed, over all of it.
 *
 * The Credit page used to add up the rows it had: `searchCustomers(db, '', 500)`
 * and then `.reduce()` over the result. On a shop with six hundred customers
 * that headline is the total owed by the first five hundred *by name* — the
 * shopkeeper is told what they are owed and it is short by however much the
 * back of the alphabet happens to owe. Nothing on the screen says so, and the
 * number is wrong in the safe-looking direction: always too small, never too
 * large, so it never looks alarming enough to question.
 *
 * Two passes instead of six hundred: the credit billed, grouped, and the money
 * taken against it, grouped, joined once. A correlated subquery per customer is
 * the obvious way to write this and it re-reads `bills` once for every name on
 * the list.
 *
 * ## All three numbers, not one
 *
 * "Owes the most" and "Over their limit" sat beside the total and were computed
 * the same wrong way, off the same five hundred rows. Fixing only the headline
 * would have left two thirds of one bug on one screen, looking fixed. They come
 * off the same two passes, so they cost nothing extra.
 *
 * ## Positive balances only, added up
 *
 * Not `SUM(credit) - SUM(payments)` over the whole shop, which is a different
 * number. A customer who has paid in advance is in credit, and their credit is
 * not available to reduce what somebody else owes — the shop still has to
 * collect that money from that person. Netting them off understates the
 * collection problem, which is the one thing this figure exists to describe.
 * It is also what the page already did by filtering to `outstanding > 0` before
 * adding, so this preserves the meaning the screen had rather than quietly
 * changing it while fixing the range.
 *
 * ## The definition is `searchCustomers`', deliberately
 *
 * Same balance expression, same `is_active = 1 AND deleted_at IS NULL`. The
 * headline and the rows beneath it have to be the same arithmetic or the page
 * contradicts itself in public, and an archived customer's old debt appearing
 * in a total but in no row would be unanswerable.
 */
export async function totalOutstandingAll(db: SqlDriver): Promise<OutstandingTotal> {
  /* raw: three common table expressions feeding six scalar sub-selects, and
     the one place in this file that still goes through the driver directly.

     The query builder has no shape for a WITH, and taking it through Drizzle as
     a raw fragment does not work either: the proxy hands raw rows back
     positionally, because a string of SQL tells it no column names. Reading
     `row.total` off that gives `undefined` -- which arithmetic turns into
     `NaN`, and a headline of NaN on the Credit page is a worse failure than the
     one this function was written to fix. So it stays as it is, named.

     Six separate round trips would read `bills` and `payment_allocations` six
     times to answer one screen.

     `balances` is every customer who has ever been billed on credit, with
       what they owe now. Starting from `billed` rather than from `customers`
       is deliberate: somebody who has never taken credit cannot owe anything,
       and on a shop with thousands of walk-in accounts that is most of the
       table.

       The two "worst" columns sort identically, name included, so a tie
       between two customers owing the same amount cannot return one person's
       name beside another person's figure. */
  const row = await db.get<{
    total: number; customers: number; over_limit: number
    worst_id: string | null; worst_name: string | null; worst_owed: number | null
  }>(
    `WITH billed AS (
       SELECT b.customer_id AS id, SUM(b.credit_total) AS amount
         FROM bills b
        WHERE b.docstatus = 1 AND b.credit_total > 0 AND b.customer_id IS NOT NULL
        GROUP BY b.customer_id
     ),
     taken AS (
       SELECT b.customer_id AS id, SUM(pa.amount) AS amount
         FROM payment_allocations pa
         JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
         JOIN bills b ON b.id = pa.bill_id
        WHERE b.customer_id IS NOT NULL
        GROUP BY b.customer_id
     ),
     balances AS (
       SELECT c.id, c.name, c.credit_limit,
              billed.amount - COALESCE(taken.amount, 0) AS owed
         FROM billed
         JOIN customers c ON c.id = billed.id
         LEFT JOIN taken ON taken.id = billed.id
        WHERE c.is_active = 1 AND c.deleted_at IS NULL
     )
     SELECT
       (SELECT COUNT(*) FROM balances WHERE owed > 0) AS customers,
       (SELECT COALESCE(SUM(owed), 0) FROM balances WHERE owed > 0) AS total,
       (SELECT COUNT(*) FROM balances WHERE credit_limit > 0 AND owed > credit_limit) AS over_limit,
       (SELECT id   FROM balances WHERE owed > 0 ORDER BY owed DESC, name LIMIT 1) AS worst_id,
       (SELECT name FROM balances WHERE owed > 0 ORDER BY owed DESC, name LIMIT 1) AS worst_name,
       (SELECT owed FROM balances WHERE owed > 0 ORDER BY owed DESC, name LIMIT 1) AS worst_owed`,
  )

  return {
    total: (row?.total ?? 0) as Money,
    customers: row?.customers ?? 0,
    overLimit: row?.over_limit ?? 0,
    worst: row?.worst_id
      ? { id: row.worst_id, name: row.worst_name ?? '', outstanding: (row.worst_owed ?? 0) as Money }
      : null,
  }
}

export interface CustomerStatementRow {
  billId: string
  docNo: string
  postingDate: string
  creditTotal: Money
  allocated: Money
  outstanding: Money
}

export async function customerStatement(db: SqlDriver, customerId: string): Promise<CustomerStatementRow[]> {
  const bills = await loadOpenBills(db, customerId)
  return bills
    .map((b) => ({
      billId: b.id,
      docNo: b.docNo,
      postingDate: b.postingDate,
      creditTotal: b.creditTotal,
      allocated: b.allocated,
      outstanding: sub(b.creditTotal, b.allocated),
    }))
    .filter((r) => r.outstanding > 0)
    .sort((a, b) => a.postingDate.localeCompare(b.postingDate))
}
