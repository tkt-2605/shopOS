import type { ProductListItem, DocumentKind, CostHint } from '@shopos/core'

export interface DeskConfig {
  /** The kinds this page offers, in the order the segment shows them. */
  kinds: DocumentKind[]
  /** Which side of the shop the document is addressed to. */
  party: 'customer' | 'supplier'
  /** What each kind is called, and the sentence under the tab explaining it. */
  labels: Record<string, { name: string; plural: string; note: string }>
}

export interface Line {
  key: string
  product: ProductListItem
  qty: string
  /** A rate somebody typed. Blank means "whatever the price list says today". */
  rate: string
  /**
   * On a purchase order: what the item last cost the shop (`costHints`), and
   * whether the rate is still that figure rather than one somebody typed. A
   * filled-in rate follows the before/after GST choice; a typed one is kept.
   */
  hint?: CostHint | null
  rateFilled?: boolean
}
