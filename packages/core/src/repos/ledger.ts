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
