import type { SqlDriver } from '../../db/driver.js'
import type { Qty } from '../../quantity.js'
import { postMovement, issuedUnitCost } from '../stock.js'
import { putBackReturn } from '../batches.js'

/**
 * Puts returned goods back on the shelf: into the ledger at the cost they
 * went out at, and into the batches the bill line took them from.
 */
export async function restock(
  tx: SqlDriver,
  input: {
    returnId: string
    billId: string
    postingDate: string
    actorId: string
    lines: readonly { billItemId: string; productId: string; baseQty: Qty }[]
  },
): Promise<void> {
  await putBackReturn(tx, {
    returnId: input.returnId,
    postingDate: input.postingDate,
    userId: input.actorId,
    lines: input.lines.map((l) => ({ billItemId: l.billItemId, productId: l.productId, qty: l.baseQty })),
  })

  for (const line of input.lines) {
    await postMovement(tx, {
      productId: line.productId,
      qtyChange: line.baseQty,
      unitCost: await issuedUnitCost(tx, 'bill', input.billId, line.productId),
      voucherType: 'sales_return',
      voucherId: input.returnId,
      postingDate: input.postingDate,
      userId: input.actorId,
    })
  }
}
