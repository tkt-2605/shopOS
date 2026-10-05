import type { Money } from '../money.js'

/**
 * The chart of accounts, and the one rule every posting obeys.
 *
 * In code rather than in a table. A shop this size does not design its own
 * chart, and a table would be one more thing two tills could disagree about.
 * Each account has a stable key -- what `gl_entries.account` holds -- and its
 * kind, which decides which side its balance normally sits on and where it
 * appears in the statements. Adding an account is adding a line here; renaming
 * one is changing its `name`, never its key.
 *
 * What the cash account is, honestly: the money taken through the drawer, net
 * of refunds, payouts and counting differences. The float a shop starts a
 * drawer with and the cash it takes to the bank are not recorded as movements
 * anywhere in this product yet, so they are not here either. It is the
 * drawer's own ledger, not a count of the cash in the building.
 */

export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export interface Account {
  name: string
  kind: AccountKind
}

export const ACCOUNTS = {
  cash: { name: 'Cash taken at the counter', kind: 'asset' },
  upi: { name: 'UPI and bank transfers', kind: 'asset' },
  card: { name: 'Card receipts', kind: 'asset' },
  debtors: { name: 'Customers (khata)', kind: 'asset' },
  stock: { name: 'Stock in hand', kind: 'asset' },
  input_cgst: { name: 'Input CGST', kind: 'asset' },
  input_sgst: { name: 'Input SGST', kind: 'asset' },
  input_igst: { name: 'Input IGST', kind: 'asset' },
  input_cess: { name: 'Input cess', kind: 'asset' },

  creditors: { name: 'Suppliers', kind: 'liability' },
  output_cgst: { name: 'Output CGST', kind: 'liability' },
  output_sgst: { name: 'Output SGST', kind: 'liability' },
  output_igst: { name: 'Output IGST', kind: 'liability' },
  output_cess: { name: 'Output cess', kind: 'liability' },

  opening_balance: { name: 'Opening balances', kind: 'equity' },

  sales: { name: 'Sales', kind: 'income' },
  round_off: { name: 'Round off', kind: 'income' },

  cogs: { name: 'Cost of goods sold', kind: 'expense' },
  stock_adjustment: { name: 'Stock adjustments and wastage', kind: 'expense' },
  write_off: { name: 'Debts written off', kind: 'expense' },
  expenses: { name: 'Paid out of the drawer', kind: 'expense' },
  loyalty: { name: 'Loyalty points redeemed', kind: 'expense' },
  cash_over_short: { name: 'Drawer over and short', kind: 'expense' },
} as const satisfies Record<string, Account>

export type AccountKey = keyof typeof ACCOUNTS

export function isAccount(key: string): key is AccountKey {
  return Object.prototype.hasOwnProperty.call(ACCOUNTS, key)
}

/** Where a tender lands. Credit is the khata; points are what they cost the shop. */
export function tenderAccount(method: string): AccountKey {
  switch (method) {
    case 'cash': return 'cash'
    case 'upi': return 'upi'
    case 'card': return 'card'
    case 'credit': return 'debtors'
    case 'loyalty': return 'loyalty'
    default: throw new Error(`no account for the tender "${method}"`)
  }
}

export interface GlParty {
  type: 'customer' | 'supplier'
  /** Null for goods bought from nobody named. */
  id: string | null
}

/** One line of a posting: an amount on one side of one account. */
export interface GlLine {
  account: AccountKey
  debit: Money
  credit: Money
  party?: GlParty | null
}

export const debit = (account: AccountKey, amount: number, party?: GlParty | null): GlLine =>
  ({ account, debit: amount as Money, credit: 0 as Money, party: party ?? null })

export const credit = (account: AccountKey, amount: number, party?: GlParty | null): GlLine =>
  ({ account, debit: 0 as Money, credit: amount as Money, party: party ?? null })

/**
 * The lines as they will be written: a negative amount moved to the other
 * side, zero lines dropped. Builders write `debit(x, n)` for whatever n comes
 * to -- a round-off can be either sign -- and this is where that is settled.
 */
export function normalise(lines: readonly GlLine[]): GlLine[] {
  const out: GlLine[] = []
  for (const l of lines) {
    const net = l.debit - l.credit
    if (net === 0) continue
    out.push(net > 0
      ? { ...l, debit: net as Money, credit: 0 as Money }
      : { ...l, debit: 0 as Money, credit: (-net) as Money })
  }
  return out
}

export class UnbalancedPostingError extends Error {
  constructor(readonly voucher: string, readonly debits: number, readonly credits: number) {
    super(`${voucher} does not balance: debits ${debits}, credits ${credits}`)
    this.name = 'UnbalancedPostingError'
  }
}

/** Throws unless the debits equal the credits. A posting that does not balance is a bug, every time. */
export function assertBalanced(voucher: string, lines: readonly GlLine[]): void {
  const debits = lines.reduce((s, l) => s + l.debit, 0)
  const credits = lines.reduce((s, l) => s + l.credit, 0)
  if (debits !== credits) throw new UnbalancedPostingError(voucher, debits, credits)
}

/** A balance the way its kind reads it: an asset's debit, a liability's credit. */
export function naturalBalance(kind: AccountKind, debits: number, credits: number): number {
  return kind === 'asset' || kind === 'expense' ? debits - credits : credits - debits
}
