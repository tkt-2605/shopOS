import { eq, asc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import type { Qty } from '../../quantity.js'
import { writeAudit } from '../../integrity/audit.js'

/*
 * How much of an order has been delivered, moved by the bills taken against
 * it and moved back when one of them is cancelled.
 */

/**
 * Marks an order off against the bill that is paying for it.
 *
 * Runs inside `submitBill`'s own transaction, and that is the entire point: an
 * order is marked off by the payment, never by the cart. A cashier who pulls an
 * order onto the counter and is then interrupted has delivered nothing, and an
 * order the shop believes it has already sent out is a worse record than one
 * that says nothing at all.
 *
 * Matching is by item, taking the oldest unfinished line first. Quantities go
 * through each order line's own base ratio, so a bill written in pieces marks
 * off an order written in dozens.
 *
 * What it took is written down rather than inferred, because cancelling the
 * bill has to give back exactly what this bill took — and by then another bill
 * may have consumed the rest of the line, so the share cannot be worked out
 * again afterwards.
 */
export async function applyBillFulfilment(
  tx: SqlDriver,
  input: { billId: string; documentId: string; actorId: string; now: Date },
): Promise<void> {
  /* Summed per item: one order line can be billed across two lines of the same
     cart, and two cart lines competing for the same remainder would each see it
     as whole. */
  const billed = await q(tx)
    .select({
      productId: schema.billItems.productId,
      baseQty: sql<number>`SUM(${schema.billItems.baseQty})`,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, input.billId))
    .groupBy(schema.billItems.productId)
  if (billed.length === 0) return

  const lines = await q(tx)
    .select({
      id: schema.documentItems.id,
      productId: schema.documentItems.productId,
      qty: schema.documentItems.qty,
      baseQty: schema.documentItems.baseQty,
      fulfilledQty: schema.documentItems.fulfilledQty,
    })
    .from(schema.documentItems)
    .where(eq(schema.documentItems.documentId, input.documentId))
    .orderBy(asc(schema.documentItems.idx))
  if (lines.length === 0) return

  const nowIso = input.now.toISOString()
  let marked = 0

  for (const sold of billed) {
    let leftInBase = sold.baseQty

    for (const line of lines) {
      if (leftInBase <= 0) break
      if (line.productId !== sold.productId) continue

      const remaining = line.qty - line.fulfilledQty
      if (remaining <= 0) continue

      const remainingInBase = Math.round((remaining * line.baseQty) / line.qty)
      const takenInBase = Math.min(leftInBase, remainingInBase)
      const taken = Math.min(remaining, Math.round((takenInBase * line.qty) / line.baseQty))
      /* A bill line smaller than one thousandth of an order line's unit rounds
         to nothing here. It is left alone rather than marked off as zero: an
         order that says it is short by an amount nobody can see is still true. */
      if (taken <= 0) continue

      await q(tx).update(schema.documentItems)
        .set({ fulfilledQty: sql`${schema.documentItems.fulfilledQty} + ${taken}` })
        .where(eq(schema.documentItems.id, line.id))

      await q(tx).insert(schema.billFulfilments).values({
        id: newId(),
        billId: input.billId,
        documentId: input.documentId,
        documentItemId: line.id,
        qty: taken as Qty,
        createdAt: nowIso,
      })

      line.fulfilledQty = (line.fulfilledQty + taken) as Qty
      leftInBase -= takenInBase
      marked += 1
    }
  }

  /* Nothing on the bill answered anything still open on the order — a cart
     emptied and refilled with other items, most often. The bill stands; the
     order is simply not touched, and the audit row is not written either,
     because no change was made to record. */
  if (marked === 0) return

  await writeAudit(tx, { actorId: input.actorId }, {
    entity: 'document',
    entityId: input.documentId,
    action: 'update',
    after: { billed_by: input.billId },
  })
}

/**
 * Gives back what a cancelled bill had taken: the order's figure comes down,
 * and the bill's own record of what it took stays, as a cancelled bill's other
 * lines do.
 *
 * Reads the working rather than recomputing the share: this bill's rows say
 * exactly what it marked off, and they are the only answer that stays right
 * once a later bill has taken the rest of the line.
 */
export async function reverseBillFulfilment(
  tx: SqlDriver,
  input: { billId: string; actorId: string },
): Promise<void> {
  const taken = await q(tx)
    .select({
      documentId: schema.billFulfilments.documentId,
      documentItemId: schema.billFulfilments.documentItemId,
      qty: schema.billFulfilments.qty,
    })
    .from(schema.billFulfilments)
    .where(eq(schema.billFulfilments.billId, input.billId))
  if (taken.length === 0) return

  for (const row of taken) {
    /* `MAX(0, ...)` and not a bare subtraction: two cancellations racing, or a
       row put back by hand, must not leave an order claiming a negative
       delivery. */
    /* And never below what the bills still standing and the conversions add up
       to: an order billed on two counters while apart holds what it ordered,
       not twice that, and taking one bill's share off it read nought while the
       other bill still stood -- parting this till from every till that heard
       of the cancellation by merge. */
    await q(tx).update(schema.documentItems)
      .set({
        fulfilledQty: sql`MAX(0, ${schema.documentItems.fulfilledQty} - ${row.qty}, COALESCE((
          SELECT SUM(bf.qty) FROM bill_fulfilments bf JOIN bills b ON b.id = bf.bill_id AND b.docstatus = 1
           WHERE bf.document_item_id = ${schema.documentItems.id} AND bf.bill_id <> ${input.billId}), 0)
          + COALESCE((SELECT SUM(df.qty) FROM document_fulfilments df
           WHERE df.document_item_id = ${schema.documentItems.id}), 0))`,
      })
      .where(eq(schema.documentItems.id, row.documentItemId))
  }
  /* The rows stay. They are lines of the bill, and a submitted document's
     lines are frozen against the merge: a cancellation that deleted them was
     refused by every other till ("different bill_fulfilments"), so a bill made
     from an order and cancelled on one till stood on all the others for good.
     Every count of what an order has had reads only bills still standing. */

  for (const documentId of new Set(taken.map((t) => t.documentId))) {
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: documentId,
      action: 'update',
      after: { unbilled_by: input.billId },
    })
  }
}

/* ------------------------------------------------------------ private --- */
