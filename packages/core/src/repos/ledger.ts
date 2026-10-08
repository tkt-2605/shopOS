import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { ACCOUNTS, isAccount, naturalBalance, type AccountKey, type AccountKind } from '../domain/ledger.js'

/*
 * What the books say: the trial balance, the profit and loss for a period,
 * the balance sheet on a day, and the checks that the books agree with the
 * ledgers they are posted from.
 *
 * raw: every statement here is one grouped sum over `gl_entries` with a date
 * window, which is clearer as the SQL than as the builder.
 */

export interface AccountBalance {
  account: AccountKey
  name: string
  kind: AccountKind
  debit: Money
  credit: Money
  /** On the side the account normally sits: an asset's debit, a liability's credit. */
  balance: Money
}

async function sums(db: SqlDriver, from: string | null, to: string): Promise<AccountBalance[]> {
  const rows = await db.query<{ account: string; debit: number; credit: number }>(
    `SELECT account, COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
       FROM gl_entries
      WHERE posting_date <= ? ${from ? 'AND posting_date >= ?' : ''}
      GROUP BY account`,
    from ? [to, from] : [to],
  )
  return rows
    .filter((r) => isAccount(r.account))
    .map((r) => {
      const a = ACCOUNTS[r.account as AccountKey]
      return {
        account: r.account as AccountKey, name: a.name, kind: a.kind,
        debit: r.debit as Money, credit: r.credit as Money,
        balance: naturalBalance(a.kind, r.debit, r.credit) as Money,
      }
    })
    .sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.name.localeCompare(y.name))
}

const KIND_ORDER: AccountKind[] = ['asset', 'liability', 'equity', 'income', 'expense']

export interface TrialBalance {
  rows: AccountBalance[]
  debit: Money
  credit: Money
}

/** Every account's debits and credits up to a day. The two totals are equal, or something is wrong. */
export async function trialBalance(db: SqlDriver, asOf: string): Promise<TrialBalance> {
  const rows = await sums(db, null, asOf)
  return {
    rows,
    debit: rows.reduce((s, r) => s + r.debit, 0) as Money,
    credit: rows.reduce((s, r) => s + r.credit, 0) as Money,
  }
}

export interface ProfitAndLoss {
  income: AccountBalance[]
  expense: AccountBalance[]
  totalIncome: Money
  totalExpense: Money
  /** Income less expense. Negative is a loss. */
  profit: Money
}

/** What the shop made over a period: sales, less what they cost and what was spent. */
export async function profitAndLoss(db: SqlDriver, range: { from: string; to: string }): Promise<ProfitAndLoss> {
  const rows = await sums(db, range.from, range.to)
  const income = rows.filter((r) => r.kind === 'income')
  const expense = rows.filter((r) => r.kind === 'expense')
  const totalIncome = income.reduce((s, r) => s + r.balance, 0) as Money
  const totalExpense = expense.reduce((s, r) => s + r.balance, 0) as Money
  return { income, expense, totalIncome, totalExpense, profit: (totalIncome - totalExpense) as Money }
}

export interface BalanceSheet {
  assets: AccountBalance[]
  liabilities: AccountBalance[]
  equity: AccountBalance[]
  /** Everything earned less everything spent, to the day: the profit not yet taken out. */
  retainedProfit: Money
  totalAssets: Money
  /** Liabilities, equity and retained profit. Equal to the assets, always. */
  totalClaims: Money
}

/** What the shop owns and owes on a day. */
export async function balanceSheet(db: SqlDriver, asOf: string): Promise<BalanceSheet> {
  const rows = await sums(db, null, asOf)
  const of = (kind: AccountKind) => rows.filter((r) => r.kind === kind)
  const total = (list: AccountBalance[]) => list.reduce((s, r) => s + r.balance, 0)
  const retainedProfit = (total(of('income')) - total(of('expense'))) as Money
  return {
    assets: of('asset'),
    liabilities: of('liability'),
    equity: of('equity'),
    retainedProfit,
    totalAssets: total(of('asset')) as Money,
    totalClaims: (total(of('liability')) + total(of('equity')) + retainedProfit) as Money,
  }
}

export interface LedgerChecks {
  /** Vouchers whose own entries do not balance. Always empty unless something wrote the table by hand. */
  unbalanced: { voucherType: string; voucherId: string; difference: Money }[]
  /**
   * The stock account less what the stock ledger says the stock is worth.
   * Zero when every movement has been posted; anything else is a document the
   * books have not caught up with, or a movement written outside a document.
   */
  stockDrift: Money
}

/** Whether the books agree with themselves, and with the stock ledger they are posted from. */
export async function ledgerChecks(db: SqlDriver): Promise<LedgerChecks> {
  const unbalanced = await db.query<{ voucher_type: string; voucher_id: string; difference: number }>(
    `SELECT voucher_type, voucher_id, SUM(debit) - SUM(credit) AS difference
       FROM gl_entries GROUP BY voucher_type, voucher_id HAVING SUM(debit) <> SUM(credit)`,
  )
  const stock = await db.get<{ gl: number; ledger: number }>(
    `SELECT (SELECT COALESCE(SUM(debit) - SUM(credit), 0) FROM gl_entries WHERE account = 'stock') AS gl,
            (SELECT COALESCE(SUM(value_change), 0) FROM stock_ledger) AS ledger`,
  )
  return {
    unbalanced: unbalanced.map((u) => ({
      voucherType: u.voucher_type, voucherId: u.voucher_id, difference: u.difference as Money,
    })),
    stockDrift: ((stock?.gl ?? 0) - (stock?.ledger ?? 0)) as Money,
  }
}

/** What one party owes or is owed in the books: a customer's khata, a supplier's account. */
export async function partyBalance(
  db: SqlDriver,
  party: { type: 'customer' | 'supplier'; id: string },
): Promise<Money> {
  const account = party.type === 'customer' ? 'debtors' : 'creditors'
  const row = await db.get<{ debit: number; credit: number }>(
    `SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
       FROM gl_entries WHERE account = ? AND party_type = ? AND party_id = ?`,
    [account, party.type, party.id],
  )
  const kind = ACCOUNTS[account].kind
  return naturalBalance(kind, row?.debit ?? 0, row?.credit ?? 0) as Money
}

/** What each kind of document is called on the ledger page. */
export const VOUCHER_LABEL: Readonly<Record<string, string>> = {
  bill: 'Bill',
  sales_return: 'Return',
  payment: 'Payment',
  stock_entry: 'Stock entry',
  cash_session: 'Drawer close',
  cash_payout: 'Paid out',
  supplier_opening: 'Opening balance',
}

export interface LedgerFilter {
  from: string
  to: string
  /** One account, such as `debtors` for every customer's khata. Absent is every account. */
  account?: AccountKey | null
  /** One customer or supplier. Absent is everybody. */
  party?: { type: 'customer' | 'supplier'; id: string } | null
  /** The most rows to answer, newest dropped first. Defaults to 2,000. */
  limit?: number
}

export interface LedgerRow {
  id: string
  postingDate: string
  account: AccountKey
  accountName: string
  partyType: 'customer' | 'supplier' | null
  partyId: string | null
  partyName: string | null
  voucherType: string
  voucherLabel: string
  voucherId: string
  /** The document's own number, where it has one. */
  docNo: string | null
  debit: Money
  credit: Money
  /** Undoes an earlier entry: the document was cancelled. */
  isReversal: boolean
  /** Debit less credit, running, from the opening balance. */
  balance: Money
}

export interface GeneralLedger {
  /** Debit less credit before `from`, under the same filter. */
  opening: Money
  rows: LedgerRow[]
  debit: Money
  credit: Money
  /** Debit less credit at the end of the range. */
  closing: Money
  /** True when there were more rows than `limit`; the totals still count all of them. */
  truncated: boolean
}

/**
 * Every entry the books hold for a period, in the order they happened: each
 * bill, payment, return, delivery and drawer close, line by line, with the
 * document it came from and the customer or supplier it concerns.
 *
 * Narrowed to one account it is that account's ledger -- `debtors` is every
 * customer's credit and every payment against it in one list -- and to one
 * party it is their khata. The running balance is debit less credit, from the
 * balance brought forward, which is how a ledger is read: positive on a
 * customer is what they owe.
 *
 * raw: the document number and the party's name come from a different table
 * for each kind of entry, which is a run of LEFT JOINs the builder says no
 * more clearly.
 */
export async function generalLedger(db: SqlDriver, filter: LedgerFilter): Promise<GeneralLedger> {
  const where: string[] = []
  const args: (string | number)[] = []
  if (filter.account) { where.push('g.account = ?'); args.push(filter.account) }
  if (filter.party) { where.push('g.party_type = ? AND g.party_id = ?'); args.push(filter.party.type, filter.party.id) }
  const narrowed = where.length > 0 ? `AND ${where.join(' AND ')}` : ''
  const limit = filter.limit ?? 2000

  const before = await db.get<{ net: number }>(
    `SELECT COALESCE(SUM(g.debit - g.credit), 0) AS net FROM gl_entries g WHERE g.posting_date < ? ${narrowed}`,
    [filter.from, ...args],
  )
  const totals = await db.get<{ debit: number; credit: number; n: number }>(
    `SELECT COALESCE(SUM(g.debit), 0) AS debit, COALESCE(SUM(g.credit), 0) AS credit, COUNT(*) AS n
       FROM gl_entries g WHERE g.posting_date >= ? AND g.posting_date <= ? ${narrowed}`,
    [filter.from, filter.to, ...args],
  )
  const rows = await db.query<{
    id: string; posting_date: string; account: string; party_type: string | null; party_id: string | null
    party_name: string | null; voucher_type: string; voucher_id: string; doc_no: string | null
    debit: number; credit: number; is_reversal: number
  }>(
    `SELECT g.id, g.posting_date, g.account, g.party_type, g.party_id, g.voucher_type, g.voucher_id,
            g.debit, g.credit, g.is_reversal,
            COALESCE(c.name, s.name) AS party_name,
            CASE g.voucher_type
              WHEN 'bill' THEN b.doc_no
              WHEN 'sales_return' THEN r.doc_no
              WHEN 'payment' THEN p.doc_no
              WHEN 'stock_entry' THEN e.doc_no
            END AS doc_no
       FROM gl_entries g
       LEFT JOIN customers c ON g.party_type = 'customer' AND c.id = g.party_id
       LEFT JOIN suppliers s ON g.party_type = 'supplier' AND s.id = g.party_id
       LEFT JOIN bills b ON g.voucher_type = 'bill' AND b.id = g.voucher_id
       LEFT JOIN sales_returns r ON g.voucher_type = 'sales_return' AND r.id = g.voucher_id
       LEFT JOIN payment_entries p ON g.voucher_type = 'payment' AND p.id = g.voucher_id
       LEFT JOIN stock_entries e ON g.voucher_type = 'stock_entry' AND e.id = g.voucher_id
      WHERE g.posting_date >= ? AND g.posting_date <= ? ${narrowed}
      ORDER BY g.posting_date, g.created_at, g.id
      LIMIT ?`,
    [filter.from, filter.to, ...args, limit],
  )

  let running = before?.net ?? 0
  const out = rows.map((r): LedgerRow => {
    running += r.debit - r.credit
    return {
      id: r.id,
      postingDate: r.posting_date,
      account: r.account as AccountKey,
      accountName: isAccount(r.account) ? ACCOUNTS[r.account].name : r.account,
      partyType: r.party_type === 'customer' || r.party_type === 'supplier' ? r.party_type : null,
      partyId: r.party_id,
      partyName: r.party_name,
      voucherType: r.voucher_type,
      voucherLabel: VOUCHER_LABEL[r.voucher_type] ?? r.voucher_type,
      voucherId: r.voucher_id,
      docNo: r.doc_no,
      debit: r.debit as Money,
      credit: r.credit as Money,
      isReversal: r.is_reversal === 1,
      balance: running as Money,
    }
  })

  const opening = (before?.net ?? 0) as Money
  const debit = (totals?.debit ?? 0) as Money
  const credit = (totals?.credit ?? 0) as Money
  return {
    opening, rows: out, debit, credit,
    closing: (opening + debit - credit) as Money,
    truncated: (totals?.n ?? 0) > out.length,
  }
}
