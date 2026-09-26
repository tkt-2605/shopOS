import { eq, between, sql, type SQL } from 'drizzle-orm'
import type { SqlValue } from '../../db/driver.js'
import { schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import { SUBMITTED } from '../../integrity/docstatus.js'

/*
 * What every report is filtered by -- a date range, and optionally one
 * counter -- and the small conversions they share.
 */

export interface DateRange {
  from: string
  to: string
  registerId?: string | null
}

/**
 * The register filter as a fragment of SQL, for the one query still written by
 * hand. Everything else on this page uses `onRegister` below.
 */
export function scope(range: DateRange): { clause: string; params: SqlValue[] } {
  return range.registerId
    ? { clause: `AND b.register_id = ?`, params: [range.from, range.to, range.registerId] }
    : { clause: ``, params: [range.from, range.to] }
}

/**
 * The register filter, as a condition rather than a fragment of a string.
 *
 * Every report is scoped to one till or to all of them, and the answer is
 * always a condition on `bills` -- including for returns and for stock
 * movements, which reach it through a join. A report scoped to the wrong till
 * is not an error; it is a smaller number that looks like a quiet week.
 */
export function onRegister(range: DateRange): SQL[] {
  return range.registerId ? [eq(schema.bills.registerId, range.registerId)] : []
}

/** Submitted sales only: a draft is not a sale and a cancelled bill is not one. */
export function soldIn(range: DateRange): SQL[] {
  return [
    eq(schema.bills.docstatus, SUBMITTED),
    eq(schema.bills.kind, 'sale'),
    between(schema.bills.postingDate, range.from, range.to),
    ...onRegister(range),
  ]
}

/** The same window, dated by the return rather than by the bill it reverses. */
export function returnedIn(range: DateRange): SQL[] {
  return [
    eq(schema.salesReturns.docstatus, SUBMITTED),
    between(schema.salesReturns.postingDate, range.from, range.to),
    ...onRegister(range),
  ]
}

/** `COALESCE(SUM(col), 0)`, which is what every figure on this page is. */
export function money(column: SQL | Parameters<typeof sql.raw>[0] | object): SQL<Money> {
  return sql<Money>`COALESCE(SUM(${column}), 0)`
}

/** A credited line, which is the same figure pointing the other way. */
export function negated(column: object): SQL<Money> {
  return sql<Money>`-${column}`
}
