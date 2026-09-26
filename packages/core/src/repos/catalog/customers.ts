import { eq, and, or, like, isNull, asc, desc, count, sql, type SQL } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'

export interface CustomerListItem {
  id: string
  /** The shop's own short reference, if it gives them one. */
  code: string | null
  name: string
  phone: string | null
  gstin: string | null
  outstanding: Money
  /**
   * What the shop is holding for them, over and above any bill.
   *
   * Zero for almost everybody. A customer can have both: an advance on
   * their receipts and something owing on a bill raised since, and
   * netting the two into one signed number would lose which is which.
   */
  advance: Money
  creditLimit: Money
  loyaltyPoints: number
  /** Out of every search but this one. See `archiveCustomer`. */
  archived: boolean
}

/**
 * One customer, whole, for a form that is about to save them back.
 *
 * `CustomerListItem` is shaped for the list and carries neither the address,
 * the state nor the credit enforcement. The Customers screen was filling a form
 * from it anyway and defaulting the three it could not see -- address to empty,
 * enforcement to `hard` -- and then writing all of them back. So editing a
 * customer's phone number silently erased their address and moved a customer
 * who had been set to `none` onto hard credit enforcement, which stops them
 * buying at the counter.
 *
 * Nothing said so. It is the same failure as everything else in this phase: a
 * screen that looks like it edited one field and quietly wrote several.
 */
export interface CustomerDetail extends CustomerListItem {
  address: string | null
  stateCode: string | null
  creditEnforcement: 'none' | 'soft' | 'hard'
  isActive: boolean
}

export async function loadCustomer(db: SqlDriver, id: string): Promise<CustomerDetail | null> {
  /* Archived customers are loadable, deliberately: the screen that can bring
     one back has to be able to open them first, and an old bill's customer has
     to stay readable. The searches are where they disappear. */
  const [row] = await q(db)
    .select({
      id: schema.customers.id,
      code: schema.customers.code,
      name: schema.customers.name,
      phone: schema.customers.phone,
      gstin: schema.customers.gstin,
      address: schema.customers.address,
      stateCode: schema.customers.stateCode,
      creditLimit: schema.customers.creditLimit,
      creditEnforcement: schema.customers.creditEnforcement,
      isActive: schema.customers.isActive,
      deletedAt: schema.customers.deletedAt,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, id))
  if (!row) return null

  // The three figures the list computes are not what a form needs, and fetching
  // them here would make an edit wait on a join over every bill they ever had.
  return {
    ...row,
    creditEnforcement: row.creditEnforcement as 'none' | 'soft' | 'hard',
    archived: row.deletedAt !== null,
    isActive: row.isActive === 1,
    outstanding: 0 as Money,
    advance: 0 as Money,
    loyaltyPoints: 0,
  }
}

/**
 * How the list comes back.
 *
 * `owing` is not a nicety. This query has a `limit`, and the screens that use
 * it show a page of a larger shop -- so sorting the returned rows afterwards
 * sorts an arbitrary five hundred of six hundred, and the customer who owes
 * the most may not be among them. It has to be the database's decision.
 */
export type CustomerOrder =
  /** Alphabetical. What a picker at the counter wants. */
  | 'name'
  /** Most owed first, then most held. A collection round. */
  | 'owing'
  /** Longest since anything was billed to them. Who has gone quiet. */
  | 'oldest'

/**
 * The customers a screen should offer.
 *
 * `includeArchived` is for the one screen that can bring them back. Everywhere
 * else -- the counter's picker above all -- an archived customer is gone, which
 * is what archiving them was for.
 *
 * Ordered by name unless asked otherwise.
 */
export async function searchCustomers(
  db: SqlDriver,
  term = '',
  limit = 50,
  opts: { includeArchived?: boolean; order?: CustomerOrder } = {},
): Promise<CustomerListItem[]> {
  const now = new Date().toISOString()

  /* Hoisted, because `owing` has to sort by it. Repeating the expression in
     the ORDER BY would be two copies of a five-line correlated subquery that
     must agree to the paisa -- and the day they stop agreeing, the list is
     sorted by one number while showing another. */
  const outstanding = sql<Money>`
        COALESCE((SELECT SUM(b.credit_total) FROM bills b
                   WHERE b.customer_id = customers.id AND b.docstatus = 1), 0)
      - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                    JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                    JOIN bills b2 ON b2.id = pa.bill_id
                   WHERE b2.customer_id = customers.id), 0)`

  const advance = sql<Money>`
        MAX(0,
          COALESCE((SELECT SUM(pe.amount) FROM payment_entries pe
                     WHERE pe.customer_id = customers.id AND pe.party_type = 'customer'
                       AND pe.docstatus = 1 AND pe.direction = 'in'), 0)
        - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                      JOIN payment_entries pe2 ON pe2.id = pa.payment_id
                     WHERE pe2.customer_id = customers.id AND pe2.docstatus = 1
                       AND pe2.direction = 'in'), 0)
        - COALESCE((SELECT SUM(pe3.amount) FROM payment_entries pe3
                     WHERE pe3.customer_id = customers.id AND pe3.party_type = 'customer'
                       AND pe3.docstatus = 1 AND pe3.direction = 'out'), 0)
        )`

  const rows = await q(db)
    .select({
      id: schema.customers.id,
      code: schema.customers.code,
      name: schema.customers.name,
      phone: schema.customers.phone,
      gstin: schema.customers.gstin,
      creditLimit: schema.customers.creditLimit,
      outstanding,
      advance,
      loyaltyPoints: sql<number>`
        COALESCE((SELECT SUM(le.points - le.consumed) FROM loyalty_entries le
                   WHERE le.customer_id = customers.id AND le.cancelled_at IS NULL
                     AND (le.expires_at IS NULL OR le.expires_at > ${now})), 0)`,
      deletedAt: schema.customers.deletedAt,
    })
    .from(schema.customers)
    .where(and(
      eq(schema.customers.isActive, 1),
      ...(opts.includeArchived ? [] : [isNull(schema.customers.deletedAt)]),
      ...matchingCustomer(term),
    ))
    .orderBy(...orderFor(opts.order ?? 'name', outstanding, advance))
    .limit(limit)

  return rows.map((r) => ({ ...r, archived: r.deletedAt !== null }))
}

/**
 * The ORDER BY for a listing order.
 *
 * Name is the tiebreak in every case, so two customers owing the same amount
 * do not swap places between one load and the next -- a list that reorders
 * itself under somebody's finger is how the wrong row gets tapped.
 */
function orderFor(order: CustomerOrder, owed: SQL<Money>, held: SQL<Money>): SQL[] {
  switch (order) {
    case 'owing':
      /* Most owed first, then whoever the shop is holding most for. Both are
         loose ends and both belong at the top; owing money is the more
         pressing of the two, so it leads. */
      return [desc(owed), desc(held), asc(schema.customers.name)]
    case 'oldest':
      /* raw: the last bill's date, which is not a column on this table. */
      return [
        asc(sql`COALESCE((SELECT MAX(b3.posting_date) FROM bills b3
                           WHERE b3.customer_id = customers.id AND b3.docstatus = 1), '')`),
        asc(schema.customers.name),
      ]
    case 'name':
      return [asc(schema.customers.name)]
  }
}

/**
 * How many customers a search would find, ignoring the limit.
 *
 * `searchCustomers` stops at its limit and says nothing about having stopped,
 * so a screen showing five hundred of six hundred looks exactly like a screen
 * showing all six hundred. This is what lets it say which of the two it is.
 *
 * The filter is `searchCustomers`' filter, written out again rather than shared,
 * which is a risk worth naming: if one grows a condition the other must too.
 * The alternative was a `countOnly` flag threaded through a function whose
 * whole job is to return rows, and a boolean that changes what a function
 * returns is the worse trade.
 */
export async function countCustomers(
  db: SqlDriver,
  term = '',
  opts: { includeArchived?: boolean } = {},
): Promise<number> {
  const [row] = await q(db)
    .select({ n: count() })
    .from(schema.customers)
    .where(and(
      eq(schema.customers.isActive, 1),
      ...(opts.includeArchived ? [] : [isNull(schema.customers.deletedAt)]),
      ...matchingCustomer(term),
    ))
  return row?.n ?? 0
}

/** The name, phone and code test both of the two share. An empty term matches all. */
function matchingCustomer(term: string): SQL[] {
  const trimmed = term.trim()
  if (trimmed === '') return []
  const anywhere = `%${trimmed}%`
  return [or(
    like(schema.customers.name, anywhere),
    like(schema.customers.phone, anywhere),
    like(schema.customers.code, anywhere),
  )!]
}
