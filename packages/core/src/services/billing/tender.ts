import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import type { Money } from '../../money.js'
import { openSessionFor, postCashMovement } from '../cash.js'
import type { PaymentInput } from './types.js'

/*
 * How a submitted bill was paid, written down inside its transaction: one row
 * per tender, the drawer's share of it, and the loyalty points it spent and
 * earned.
 */

export interface Tenders {
  billId: string
  /** The counter the bill is paid at. Its open drawer, if any, takes the money. */
  registerId: string
  customerId: string | null
  payments: PaymentInput[]
  /** Points spent against this bill, as the entries they come out of. */
  redemption: { value: Money; points: number; plan: { entryId: string; points: number }[] }
  earned: { points: number; expiresAt: string | null }
  actorId: string
  now: Date
}

/**
 * Answers the drawer session the money went into -- the one open at this
 * counter now, or none -- so the bill can record it.
 */
export async function postTenders(tx: SqlDriver, t: Tenders): Promise<string | null> {
  const nowIso = t.now.toISOString()
  const sessionId = await openSessionFor(tx, t.registerId)

  for (const payment of t.payments) {
    await q(tx).insert(schema.billPayments).values({
      id: newId(),
      billId: t.billId,
      method: payment.method,
      amount: payment.amount,
      reference: payment.reference ?? null,
      tendered: payment.tendered ?? null,
    })
    // Credit moves no money today and loyalty never does.
    if (sessionId && payment.method !== 'credit') {
      await postCashMovement(tx, {
        sessionId,
        direction: 'in',
        amount: payment.amount,
        method: payment.method,
        sourceType: 'bill',
        sourceId: t.billId,
        reference: payment.reference ?? null,
        userId: t.actorId,
        now: t.now,
      })
    }
  }

  if (t.redemption.value > 0) {
    await q(tx).insert(schema.billPayments).values({
      id: newId(),
      billId: t.billId,
      method: 'loyalty',
      amount: t.redemption.value,
      reference: `${t.redemption.points} points`,
    })
  }

  for (const alloc of t.redemption.plan) {
    /* Read-modify-write in one statement, so two tills redeeming from the
       same entry cannot both read the old figure. */
    await q(tx).update(schema.loyaltyEntries)
      .set({ consumed: sql`${schema.loyaltyEntries.consumed} + ${alloc.points}` })
      .where(eq(schema.loyaltyEntries.id, alloc.entryId))

    await q(tx).insert(schema.loyaltyRedemptions).values({
      id: newId(),
      customerId: t.customerId!,
      billId: t.billId,
      loyaltyEntryId: alloc.entryId,
      points: alloc.points,
      createdAt: nowIso,
    })
  }

  if (t.earned.points > 0 && t.customerId) {
    await q(tx).insert(schema.loyaltyEntries).values({
      id: newId(),
      customerId: t.customerId,
      billId: t.billId,
      points: t.earned.points,
      earned: t.earned.points,
      earnedAt: nowIso,
      expiresAt: t.earned.expiresAt,
      createdAt: nowIso,
    })
  }
  return sessionId
}
