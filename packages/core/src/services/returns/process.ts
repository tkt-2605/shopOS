import type { SqlDriver } from '../../db/driver.js'
import { requirePermission } from '../../integrity/permissions.js'
import type { CreateReturnInput, ProcessReturnResult } from './types.js'
import { createReturn } from './create.js'
import { submitReturn } from './submit.js'
import { requireMayTakeMoney } from '../extraCounters.js'
import { allOrNothing } from '../allOrNothing.js'

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
  /* One transaction for both stages. A refusal at submit used to be cleaned
     up by deleting the draft afterwards -- a second write that a crash between
     the two would skip, leaving a return that never happened on the bill and
     its number spent. Now the refusal rolls the draft back with everything
     else, number included. */
  return allOrNothing<ProcessReturnResult>(db, async (tx, refuse) => {
    const created = await createReturn(tx, input)
    if (!created.ok) return refuse(created)
    const submitted = await submitReturn(tx, {
      returnId: created.returnId,
      actorId: input.actorId,
      ...(input.now ? { now: input.now } : {}),
    })
    return submitted.ok ? submitted : refuse(submitted)
  })
}
