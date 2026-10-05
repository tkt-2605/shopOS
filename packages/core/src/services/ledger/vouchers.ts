import type { SqlDriver } from '../../db/driver.js'
import { businessDate } from '../../dates.js'
import { OPENING_ADVANCE_REF } from '../../domain/credit.js'
import { credit, debit, tenderAccount, type AccountKey, type GlLine, type GlParty } from '../../domain/ledger.js'
import type { Voucher } from './post.js'

/*
 * What each kind of document posts.
 *
 * Every builder reads the document as it was submitted -- its own totals, its
 * own tenders, and what the stock ledger says its goods were worth -- and
 * works nothing out again. A builder that recomputed a tax would be a second
 * opinion about a figure the invoice has already stated.
 *
 * raw: each of these is one or two grouped sums over a document's own lines,
 * and reads more plainly as the SQL than as the builder spelling it out.
 */

export type VoucherType =
  | 'bill' | 'sales_return' | 'payment' | 'stock_entry' | 'cash_session' | 'cash_payout' | 'supplier_opening'

export interface Built {
  voucher: Voucher
  lines: GlLine[]
}

/** What the stock ledger says a voucher's movements were worth, signed: in is positive. */
export async function stockValueOf(tx: SqlDriver, voucherType: string, voucherId: string): Promise<number> {
  const row = await tx.get<{ v: number | null }>(
    `SELECT COALESCE(SUM(value_change), 0) AS v FROM stock_ledger WHERE voucher_type = ? AND voucher_id = ?`,
    [voucherType, voucherId],
  )
  return row?.v ?? 0
}

interface TaxSums { taxable: number; cgst: number; sgst: number; igst: number; cess: number }

function outputTax(side: typeof debit, t: TaxSums): GlLine[] {
  return [
    side('output_cgst', t.cgst), side('output_sgst', t.sgst),
    side('output_igst', t.igst), side('output_cess', t.cess),
  ]
}

async function billLines(tx: SqlDriver, billId: string): Promise<Built | null> {
  const bill = await tx.get<{
    kind: string; posting_date: string; customer_id: string | null; grand_total: number; round_off: number
  }>(`SELECT kind, posting_date, customer_id, grand_total, round_off FROM bills WHERE id = ?`, [billId])
  if (!bill) return null
  const voucher = { type: 'bill', id: billId, postingDate: bill.posting_date }
  const customer: GlParty | null = bill.customer_id ? { type: 'customer', id: bill.customer_id } : null

  /* What the customer owed before this shop's books began. Not a sale: it is
     the khata's opening figure, set against the opening balances. */
  if (bill.kind === 'opening') {
    return { voucher, lines: [debit('debtors', bill.grand_total, customer), credit('opening_balance', bill.grand_total)] }
  }

  const t = (await tx.get<TaxSums>(
    `SELECT COALESCE(SUM(taxable_value), 0) AS taxable, COALESCE(SUM(cgst_amount), 0) AS cgst,
            COALESCE(SUM(sgst_amount), 0) AS sgst, COALESCE(SUM(igst_amount), 0) AS igst,
            COALESCE(SUM(cess_amount), 0) AS cess
       FROM bill_items WHERE bill_id = ?`, [billId]))!
  const tenders = await tx.query<{ method: string; amount: number }>(
    `SELECT method, amount FROM bill_payments WHERE bill_id = ?`, [billId])
  const cost = -(await stockValueOf(tx, 'bill', billId))

  return {
    voucher,
    lines: [
      ...tenders.map((p) => debit(tenderAccount(p.method), p.amount, p.method === 'credit' ? customer : null)),
      credit('sales', t.taxable),
      ...outputTax(credit, t),
      // Signed: paise the customer paid on top are income, paise given up are not.
      credit('round_off', bill.round_off),
      debit('cogs', cost),
      credit('stock', cost),
    ],
  }
}

async function returnLines(tx: SqlDriver, returnId: string): Promise<Built | null> {
  const ret = await tx.get<{
    posting_date: string; refund_cash: number; refund_method: string; customer_id: string | null
  }>(
    `SELECT r.posting_date, r.refund_cash, r.refund_method, b.customer_id
       FROM sales_returns r JOIN bills b ON b.id = r.bill_id WHERE r.id = ?`, [returnId])
  if (!ret) return null
  const t = (await tx.get<TaxSums & { refund: number }>(
    `SELECT COALESCE(SUM(taxable_value), 0) AS taxable, COALESCE(SUM(cgst_amount), 0) AS cgst,
            COALESCE(SUM(sgst_amount), 0) AS sgst, COALESCE(SUM(igst_amount), 0) AS igst,
            COALESCE(SUM(cess_amount), 0) AS cess, COALESCE(SUM(refund_amount), 0) AS refund
       FROM sales_return_items WHERE return_id = ?`, [returnId]))!
  const customer: GlParty | null = ret.customer_id ? { type: 'customer', id: ret.customer_id } : null
  const back = await stockValueOf(tx, 'sales_return', returnId)

  /* The credit note undoes the sale's income and tax. What goes back to the
     customer is the money (or the khata, for a credit note against it) and the
     points they paid with, which are no longer a cost to the shop. */
  const refundAccount: AccountKey = ret.refund_method === 'credit' ? 'debtors' : tenderAccount(ret.refund_method)
  return {
    voucher: { type: 'sales_return', id: returnId, postingDate: ret.posting_date },
    lines: [
      debit('sales', t.taxable),
      ...outputTax(debit, t),
      credit(refundAccount, ret.refund_cash, refundAccount === 'debtors' ? customer : null),
      credit('loyalty', t.refund - ret.refund_cash),
      debit('stock', back),
      credit('cogs', back),
    ],
  }
}

async function paymentLines(tx: SqlDriver, paymentId: string): Promise<Built | null> {
  const pe = await tx.get<{
    posting_date: string; party_type: string; customer_id: string | null; supplier_id: string | null
    method: string; amount: number; reference: string | null; direction: string; is_credit_note: number
  }>(
    `SELECT p.posting_date, p.party_type, p.customer_id, p.supplier_id, p.method, p.amount, p.reference,
            p.direction,
            EXISTS (SELECT 1 FROM sales_returns r WHERE r.credit_note_id = p.id) AS is_credit_note
       FROM payment_entries p WHERE p.id = ?`, [paymentId])
  /* A return's credit note is posted by the return, which knows the tax it
     reverses. Posting the payment as well would put it on the khata twice. */
  if (!pe || pe.is_credit_note === 1) return null

  const supplier = pe.party_type === 'supplier'
  const party: GlParty = supplier
    ? { type: 'supplier', id: pe.supplier_id }
    : { type: 'customer', id: pe.customer_id }
  const partyAccount: AccountKey = supplier ? 'creditors' : 'debtors'
  const counter: AccountKey = pe.method === 'adjustment'
    ? (pe.reference === OPENING_ADVANCE_REF ? 'opening_balance' : 'write_off')
    : tenderAccount(pe.method)

  const lines = pe.direction === 'out'
    ? [debit(partyAccount, pe.amount, party), credit(counter, pe.amount)]
    : [debit(counter, pe.amount), credit(partyAccount, pe.amount, party)]
  return { voucher: { type: 'payment', id: paymentId, postingDate: pe.posting_date }, lines }
}

async function stockEntryLines(tx: SqlDriver, entryId: string): Promise<Built | null> {
  const entry = await tx.get<{
    entry_type: string; supplier_id: string | null; posting_date: string
    invoice_total: number; round_off: number; input_tax_claimed: number
  }>(
    `SELECT entry_type, supplier_id, posting_date, invoice_total, round_off, input_tax_claimed
       FROM stock_entries WHERE id = ?`, [entryId])
  if (!entry) return null
  const value = await stockValueOf(tx, 'stock_entry', entryId)
  const voucher = { type: 'stock_entry', id: entryId, postingDate: entry.posting_date }

  /* A supplier's bill (065). The goods at what the stock ledger valued them,
     the GST as input credit when the shop may claim it (otherwise it is already
     in that value), and the supplier owed the whole bill. The supplier's own
     rounding is round-off; anything left -- a delivery against an overdrawn
     shelf, which the ledger values at what is left over -- is an adjustment. */
  if (entry.entry_type === 'purchase') {
    const supplier: GlParty = { type: 'supplier', id: entry.supplier_id }
    const t = (await tx.get<{ cgst: number; sgst: number; igst: number; cess: number }>(
      `SELECT COALESCE(SUM(cgst_amount), 0) AS cgst, COALESCE(SUM(sgst_amount), 0) AS sgst,
              COALESCE(SUM(igst_amount), 0) AS igst, COALESCE(SUM(cess_amount), 0) AS cess
         FROM stock_entry_items WHERE entry_id = ?`, [entryId]))!
    const input = entry.input_tax_claimed === 1
      ? [debit('input_cgst', t.cgst), debit('input_sgst', t.sgst), debit('input_igst', t.igst), debit('input_cess', t.cess)]
      : []
    const claimed = entry.input_tax_claimed === 1 ? t.cgst + t.sgst + t.igst + t.cess : 0
    const left = entry.invoice_total - value - claimed - entry.round_off
    return {
      voucher,
      lines: [
        debit('stock', value), ...input,
        debit('round_off', entry.round_off), debit('stock_adjustment', left),
        credit('creditors', entry.invoice_total, supplier),
      ],
    }
  }
  const counter: AccountKey = entry.entry_type === 'opening' ? 'opening_balance' : 'stock_adjustment'
  return { voucher, lines: [debit('stock', value), credit(counter, value)] }
}

async function cashSessionLines(tx: SqlDriver, sessionId: string): Promise<Built | null> {
  const s = await tx.get<{ closed_at: string | null; variance: number | null }>(
    `SELECT closed_at, variance FROM cash_sessions WHERE id = ?`, [sessionId])
  if (!s || s.closed_at === null || !s.variance) return null
  /* Counted against expected. Over is cash the drawer has that the books did
     not; short is the other way round, and an expense. */
  return {
    voucher: { type: 'cash_session', id: sessionId, postingDate: businessDate(new Date(s.closed_at)) },
    lines: [debit('cash', s.variance), credit('cash_over_short', s.variance)],
  }
}

async function payoutLines(tx: SqlDriver, movementId: string): Promise<Built | null> {
  const m = await tx.get<{ amount: number; created_at: string; source_type: string }>(
    `SELECT amount, created_at, source_type FROM cash_movements WHERE id = ?`, [movementId])
  if (!m || m.source_type !== 'expense') return null
  return {
    voucher: { type: 'cash_payout', id: movementId, postingDate: businessDate(new Date(m.created_at)) },
    lines: [debit('expenses', m.amount), credit('cash', m.amount)],
  }
}

/**
 * What a supplier was owed from before the books began (050).
 *
 * A figure on the supplier rather than a document, and one a person corrects
 * by typing it again. So each time it is set, what is posted is the difference
 * between the figure and what the books already carry for it, as a voucher of
 * its own -- `<supplier>:0`, `<supplier>:1` -- numbered by how many came
 * before. Worked out from the same state, two tills write the same rows.
 */
async function supplierOpeningLines(tx: SqlDriver, supplierId: string): Promise<Built | null> {
  const s = await tx.get<{ opening_balance: number; opening_as_of: string | null; created_at: string }>(
    `SELECT opening_balance, opening_as_of, created_at FROM suppliers WHERE id = ?`, [supplierId])
  if (!s) return null
  const target = s.opening_as_of === null ? 0 : s.opening_balance
  const posted = await tx.get<{ held: number; vouchers: number }>(
    `SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS held, COUNT(DISTINCT voucher_id) AS vouchers
       FROM gl_entries WHERE voucher_type = 'supplier_opening' AND account = 'creditors' AND party_id = ?`,
    [supplierId])
  const delta = target - (posted?.held ?? 0)
  if (delta === 0) return null
  const supplier: GlParty = { type: 'supplier', id: supplierId }
  return {
    voucher: {
      type: 'supplier_opening',
      id: `${supplierId}:${posted?.vouchers ?? 0}`,
      postingDate: s.opening_as_of ?? businessDate(new Date(s.created_at)),
    },
    lines: [credit('creditors', delta, supplier), debit('opening_balance', delta)],
  }
}

export async function build(tx: SqlDriver, type: VoucherType, id: string): Promise<Built | null> {
  switch (type) {
    case 'supplier_opening': return supplierOpeningLines(tx, id)
    case 'bill': return billLines(tx, id)
    case 'sales_return': return returnLines(tx, id)
    case 'payment': return paymentLines(tx, id)
    case 'stock_entry': return stockEntryLines(tx, id)
    case 'cash_session': return cashSessionLines(tx, id)
    case 'cash_payout': return payoutLines(tx, id)
  }
}

/** The stock-ledger voucher a document's reversing movements are written under, if it moves stock. */
export function reversalStockVoucher(type: VoucherType): string | null {
  return type === 'bill' || type === 'sales_return' || type === 'stock_entry' ? `${type}_reversal` : null
}
