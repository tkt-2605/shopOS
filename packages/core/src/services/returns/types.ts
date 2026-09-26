import type { Money } from '../../money.js'
import type { Qty } from '../../quantity.js'

export type RefundMethod = 'cash' | 'upi' | 'card' | 'credit'

export interface ReturnLineInput {
  billItemId: string
  qty: Qty
}

export interface CreateReturnInput {
  billId: string
  lines: ReturnLineInput[]
  refundMethod: RefundMethod
  reason?: string
  actorId: string
  now?: Date
}

export type CreateReturnResult =
  | { ok: true; returnId: string; refundTotal: Money; taxReversed: Money; lineCount: number }
  | { ok: false; code: 'NO_LINES' }
  | { ok: false; code: 'BILL_NOT_SUBMITTED' }
  | { ok: false; code: 'UNKNOWN_LINE'; billItemId: string }
  | { ok: false; code: 'EXCEEDS_RETURNABLE'; billItemId: string; requested: Qty; returnable: Qty }
  | { ok: false; code: 'RETURN_BLOCKED'; productName: string }

export interface ReturnOutcome {
  returnId: string
  docNo: string
  /** The value of the goods. What the credit note reverses. */
  refundTotal: Money
  /** What left the drawer, or went onto the khata. */
  refundCash: Money
  pointsRestored: number
  pointsClawedBack: number
  creditNoteDocNo: string | null
}

export type SubmitReturnResult =
  | ({ ok: true } & ReturnOutcome)
  | { ok: false; code: 'BILL_CANCELLED' }
  | { ok: false; code: 'NOTHING_TO_CREDIT'; refund: Money; outstanding: Money }
  | { ok: false; code: 'EXCEEDS_RETURNABLE'; billItemId: string; requested: Qty; returnable: Qty }

export type ProcessReturnResult =
  | ({ ok: true } & ReturnOutcome)
  | Exclude<CreateReturnResult, { ok: true }>
  | Exclude<SubmitReturnResult, { ok: true }>
