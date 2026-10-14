import type { Money } from '../../money.js'

/** What kind of thing does not add up. */
export type DiscrepancyKind =
  | 'refunded_twice'
  | 'refunded_and_cancelled'
  | 'paid_twice'
  | 'advance_spent_twice'
  | 'points_spent_twice'
  | 'corrected_twice'
  | 'supplier_overpaid'
  | 'order_billed_twice'
  | 'sold_below_zero'
  | 'over_credit_limit'
  | 'figures_left'
  | 'books_unbalanced'
  | 'books_stock'
  | 'books_missing'
  | 'sync_dropped'
  | 'sync_set_aside'

/**
 * One thing in the shop's records that does not add up, said so that a
 * shopkeeper can act on it.
 */
export interface Discrepancy {
  /**
   * Stable while the facts are the same, and different once they change: a
   * second refund of the same line, or a new document out of the books, is a
   * new key and is told again even after the first was marked seen.
   */
  key: string
  kind: DiscrepancyKind
  /** Which part of the shop it is about. */
  area: 'money' | 'stock' | 'books' | 'records' | 'sync'
  title: string
  detail: string
  /** What to do about it. */
  action: string
  /** The money at stake, when there is a figure for it. */
  amount: Money | null
  /** Document numbers to look up. */
  refs: string[]
  /** When it last happened, when that is known. */
  at: string | null
}
