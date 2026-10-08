import type { SqlDriver } from '../../db/driver.js'
import { type Qty, negQty } from '../../quantity.js'
import { checkAvailability, postMovement, type StockShortfall } from '../stock.js'
import { issueForSale } from '../batches.js'

/*
 * What a bill does to the shelf: which lines it cannot cover, and taking the
 * goods off -- out of the ledger, and out of their batches where they have any.
 */

export interface BillStockLine {
  id: string
  idx: number
  productId: string
  productName: string
  baseQty: Qty
  /** The batch the line was priced from (070), sold out of first. */
  batchId?: string | null
}

/** The lines the shelf cannot cover. Asked before the money is taken. */
export function shortfallsOf(db: SqlDriver, lines: readonly BillStockLine[]): Promise<StockShortfall[]> {
  return checkAvailability(db, lines.map((l) => ({
    productId: l.productId, productName: l.productName, required: l.baseQty,
  })))
}

/**
 * Takes a submitted bill's goods off the shelf.
 *
 * Batches first, because stock no batch accounts for is read off the shelf as
 * it stands before the ledger moves. See `issueForSale`.
 */
export async function takeOffShelf(
  tx: SqlDriver,
  input: {
    billId: string
    postingDate: string
    actorId: string
    lines: readonly BillStockLine[]
    batchPicks?: Readonly<Record<number, string>> | undefined
  },
): Promise<void> {
  await issueForSale(tx, {
    voucherType: 'bill',
    voucherId: input.billId,
    postingDate: input.postingDate,
    userId: input.actorId,
    lines: input.lines.map((l) => ({
      lineId: l.id, productId: l.productId, qty: l.baseQty, pick: input.batchPicks?.[l.idx] ?? l.batchId ?? null,
    })),
  })

  for (const line of input.lines) {
    await postMovement(tx, {
      productId: line.productId,
      qtyChange: negQty(line.baseQty),
      voucherType: 'bill',
      voucherId: input.billId,
      postingDate: input.postingDate,
      userId: input.actorId,
    })
  }
}
