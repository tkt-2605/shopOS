import type { ProductListItem, DocumentKind, CostHint } from '@shopos/core'
import type { Side } from '../gstPair'

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
   * whether the rate is still that figure rather than one somebody typed --
   * which is all the note under the box needs to know to say "was".
   */
  hint?: CostHint | null
  rateFilled?: boolean
  /** On a purchase order: which box the rate was typed in, before GST or with it (`gstPair.ts`). */
  rateSide?: Side
}
