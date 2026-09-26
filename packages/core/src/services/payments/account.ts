import { eq, and, ne, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, ZERO } from '../../money.js'
import { SUBMITTED } from '../../integrity/docstatus.js'
import { advanceCredit } from './advance.js'

export type StatementKind =
  /** What they owed before this shop started keeping the account here. */
  | 'opening'
  /** Goods taken. */
  | 'bill'
  /** Paid there and then, when the bill was made. */
  | 'counter'
  /** Paid later, against the account. */
  | 'receipt'
  /** Goods came back. */
  | 'return'
  /** Given up on. */
  | 'writeoff'
  /** Money the shop was holding, handed back. */
  | 'refund'

export interface StatementEntry {
  kind: StatementKind
  id: string
  docNo: string
  postingDate: string
  /** What the line says on the page, already in words. */
  description: string
  /** Increases what they owe. */
  debit: Money
  /** Reduces it. */
  credit: Money
  /** What is owed after this line — the figure the customer reads. */
  balance: Money
}

export interface CustomerAccount {
  /** Owed at the start of the window. Zero when the window is the whole account. */
  openingBalance: Money
  entries: StatementEntry[]
  /**
   * Owed at the end of it. Negative when the shop is the one holding money.
   *
   * Kept signed rather than clamped, because a statement has to add up: the
   * closing figure is the opening figure plus every line between, and a number
   * that had been floored at zero would make the page stop reconciling. What a
   * screen should *say* about a negative one is `advance` below, which is the
   * same money with the sign taken off and a name put on it.
   */
  closingBalance: Money
  /**
   * What the shop is holding for them, over and above any bill.
   *
   * Zero for almost every customer. It is not simply `-closingBalance`: a
   * customer can be in credit on their receipts and owing on a bill raised
   * since, and the two figures answer different questions.
   */
  advance: Money
  /** The three figures a customer looks for at the bottom of a statement. */
  totals: { bought: Money; paid: Money; returned: Money }
}

/**
 * A customer's account, the way a bank states one.
 *
 * The khata ledger this replaces listed only what had been put on credit, so a
 * customer who paid cash for eleven months appeared to have bought nothing —
 * no use as a statement, because the first thing anybody checks is whether
 * their purchases are all there.
 *
 * So every document appears, and the balance still means exactly one thing:
 * what is owed right now. A bill is a debit for its full value and the money
 * handed over at the counter is a credit on the same day, which nets a cash
 * sale to nothing while still showing it. That is the two-line shape a bank
 * statement uses, and it is what lets the balance be read at any row rather
 * than only at the bottom.
 *
 * The one trap is a return refunded onto the account: that refund raises a
 * credit note, which is a payment entry, so counting both the goods coming back
 * and the credit note would take the balance down twice for one lot of goods.
 * The return carries the credit and the note it raised is left out —
 * `sales_returns.credit_note_id` names it, so there is nothing to guess.
 */
export async function customerAccount(
  db: SqlDriver,
  customerId: string,
  range: { from?: string; to?: string } = {},
): Promise<CustomerAccount> {
  const from = range.from ?? null
  const to = range.to ?? null

  const bills = await q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      postingDate: schema.bills.postingDate,
      kind: schema.bills.kind,
      grandTotal: schema.bills.grandTotal,
      creditTotal: schema.bills.creditTotal,
    })
    .from(schema.bills)
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
    ))

  const counterPaid = await q(db)
    .select({
      billId: schema.billPayments.billId,
      method: schema.billPayments.method,
      paid: sql<Money>`SUM(${schema.billPayments.amount})`,
    })
    .from(schema.billPayments)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billPayments.billId))
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
      ne(schema.billPayments.method, 'credit'),
    ))
    .groupBy(schema.billPayments.billId, schema.billPayments.method)

  const returns = await q(db)
    .select({
      id: schema.salesReturns.id,
      docNo: schema.salesReturns.docNo,
      postingDate: schema.salesReturns.postingDate,
      refundTotal: schema.salesReturns.refundTotal,
      refundMethod: schema.salesReturns.refundMethod,
      creditNoteId: schema.salesReturns.creditNoteId,
    })
    .from(schema.salesReturns)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.salesReturns.docstatus, SUBMITTED),
    ))

  const payments = await q(db)
    .select({
      id: schema.paymentEntries.id,
      docNo: schema.paymentEntries.docNo,
      postingDate: schema.paymentEntries.postingDate,
      amount: schema.paymentEntries.amount,
      method: schema.paymentEntries.method,
      reference: schema.paymentEntries.reference,
      direction: schema.paymentEntries.direction,
    })
    .from(schema.paymentEntries)
    .where(and(
      eq(schema.paymentEntries.customerId, customerId),
      eq(schema.paymentEntries.partyType, 'customer'),
      eq(schema.paymentEntries.docstatus, SUBMITTED),
    ))

  const raisedByReturn = new Set(
    returns.map((r) => r.creditNoteId).filter((id): id is string => id !== null),
  )

  type Row = Omit<StatementEntry, 'balance'>
  const rows: Row[] = []

  for (const b of bills) {
    rows.push({
      kind: b.kind === 'opening' ? 'opening' : 'bill',
      id: b.id,
      docNo: b.docNo,
      postingDate: b.postingDate,
      description: b.kind === 'opening' ? 'Balance brought forward' : 'Goods',
      debit: b.grandTotal,
      credit: ZERO,
    })
  }

  for (const p of counterPaid) {
    const bill = bills.find((b) => b.id === p.billId)
    if (!bill) continue
    rows.push({
      kind: 'counter',
      id: `${p.billId}-${p.method}`,
      docNo: bill.docNo,
      postingDate: bill.postingDate,
      description: p.method === 'loyalty'
        ? 'Paid with points'
        : `Paid at the counter — ${titleOf(p.method)}`,
      debit: ZERO,
      credit: p.paid,
    })
  }

  for (const r of returns) {
    const onAccount = r.creditNoteId !== null
    rows.push({
      kind: 'return',
      id: r.id,
      docNo: r.docNo,
      postingDate: r.postingDate,
      description: onAccount
        ? 'Goods returned — put on your account'
        : `Goods returned — refunded in ${titleOf(r.refundMethod).toLowerCase()}`,
      debit: ZERO,
      // Money handed back leaves the account where it was: the goods went back
      // and so did the cash.
      credit: onAccount ? r.refundTotal : ZERO,
    })
  }

  for (const p of payments) {
    if (raisedByReturn.has(p.id)) continue

    /* Money handed back out of the drawer. A debit, because the account runs
       from the shop's side: what the customer owes goes up by exactly what they
       were given, which takes an account sitting at -490 back to zero rather
       than to -980. */
    if (p.direction === 'out') {
      rows.push({
        kind: 'refund',
        id: p.id,
        docNo: p.docNo,
        postingDate: p.postingDate,
        description: `Credit refunded — ${titleOf(p.method)}`,
        debit: p.amount,
        credit: ZERO,
      })
      continue
    }

    const written = p.method === 'adjustment' && p.reference === 'Written off'
    rows.push({
      kind: written ? 'writeoff' : 'receipt',
      id: p.id,
      docNo: p.docNo,
      postingDate: p.postingDate,
      description: written
        ? 'Written off'
        : p.method === 'adjustment'
          ? (p.reference ?? 'Adjustment')
          : `Payment — ${titleOf(p.method)}`,
      debit: ZERO,
      credit: p.amount,
    })
  }

  /* Oldest first, and within a day a bill before the money paid against it. The
     total is the same either way, but a statement is read down the page and a
     receipt listed above the bill it settles looks like an error. */
  const order: Record<StatementKind, number> = {
    opening: 0, bill: 1, counter: 2, return: 3, receipt: 4, writeoff: 5,
    // Last within a day: money can only be handed back after it was handed
    // over, and a refund listed above the receipt it came out of reads as the
    // shop paying somebody who had paid nothing.
    refund: 6,
  }
  rows.sort((a, b) => (
    a.postingDate !== b.postingDate
      ? a.postingDate.localeCompare(b.postingDate)
      : order[a.kind] !== order[b.kind]
        ? order[a.kind] - order[b.kind]
        : a.docNo.localeCompare(b.docNo)
  ))

  let running = 0
  let openingBalance = 0
  const entries: StatementEntry[] = []
  let bought = 0
  let paid = 0
  let returned = 0

  for (const row of rows) {
    running += row.debit - row.credit

    /* Anything before the window is not listed; it is the figure the window
       starts from, which is what makes a dated statement add up rather than
       begin in the middle of a balance nobody can account for. */
    if (from !== null && row.postingDate < from) { openingBalance = running; continue }
    if (to !== null && row.postingDate > to) continue

    if (row.kind === 'bill' || row.kind === 'opening') bought += row.debit
    if (row.kind === 'counter' || row.kind === 'receipt') paid += row.credit
    // Counted off the goods rather than off the credit, because a refund handed
    // back in cash is still a return even though the account did not move.
    if (row.kind === 'return') {
      const r = returns.find((x) => x.id === row.id)
      returned += r?.refundTotal ?? 0
    }

    entries.push({ ...row, balance: running as Money })
  }

  return {
    openingBalance: openingBalance as Money,
    entries,
    closingBalance: running as Money,
    advance: (await advanceCredit(db, customerId)).amount,
    totals: {
      bought: bought as Money,
      paid: paid as Money,
      returned: returned as Money,
    },
  }
}

function titleOf(method: string): string {
  return method === 'upi' ? 'UPI' : method.charAt(0).toUpperCase() + method.slice(1)
}
