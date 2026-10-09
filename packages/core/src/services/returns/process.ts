import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { requirePermission } from '../../integrity/permissions.js'
import type { CreateReturnInput, ProcessReturnResult } from './types.js'
import { createReturn } from './create.js'
import { submitReturn } from './submit.js'
import { requireMayTakeMoney } from '../extraCounters.js'

/*
 * A return taken in one step, as the counter takes one: raised and posted
 * together, or not at all. Its own file because it is the one place that
 * strings the two stages together, and so the one place that has to ask for
 * both rights before either is used -- otherwise a person allowed to raise a
 * return but not to post it would leave a draft behind on every attempt.
 */

/**
 * A return is taken complete, the way a receipt is.
 *
 * There is no half-made return to come back to: the customer is standing at the
 * counter holding the goods. The draft step still exists underneath — the
 * document has a docstatus and a cancel path — but nobody is asked to walk it.
 */
export async function processReturn(db: SqlDriver, input: CreateReturnInput): Promise<ProcessReturnResult> {
  await requirePermission(db, input.actorId, 'sales_return', 'create')
  await requireMayTakeMoney(db)
  await requirePermission(db, input.actorId, 'sales_return', 'submit')
  const created = await createReturn(db, input)
  if (!created.ok) return created

  const submitted = await submitReturn(db, {
    returnId: created.returnId,
    actorId: input.actorId,
    ...(input.now ? { now: input.now } : {}),
  })

  // A refusal at submit would otherwise leave a draft nobody will ever finish,
  // silting the bill up with returns that did not happen.
  if (!submitted.ok) {
    await q(db).delete(schema.salesReturnItems)
      .where(eq(schema.salesReturnItems.returnId, created.returnId))
    await q(db).delete(schema.salesReturns)
      .where(eq(schema.salesReturns.id, created.returnId))
  }
  return submitted
}
