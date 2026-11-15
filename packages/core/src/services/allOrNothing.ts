import type { SqlDriver } from '../db/driver.js'

/**
 * Several writes that are one change: all of them land, or none does.
 *
 * Services answer a refusal with a result (`{ ok: false, code }`), not a throw,
 * and a transaction only rolls back on a throw. So inside `fn` a refusal goes
 * through `refuse`, which throws it past the transaction -- undoing every write
 * before it, including those made by services called inside, since a nested
 * `transaction` joins the outer one -- and hands the same result back to the
 * caller as if it had been returned. Anything else thrown is a fault and stays
 * one.
 *
 * Found by the atomicity audit of 13 Nov: a return refused at submit, a split
 * into variants, a double price settled and a ladder saved could each be left
 * half-written by a refusal or a crash partway.
 */
export async function allOrNothing<R>(
  db: SqlDriver,
  fn: (tx: SqlDriver, refuse: (result: R) => never) => Promise<R>,
): Promise<R> {
  const refuse = (result: R): never => { throw new Refusal(result) }
  try {
    return await db.transaction((tx) => fn(tx, refuse))
  } catch (err) {
    if (err instanceof Refusal) return err.result as R
    throw err
  }
}

class Refusal<R> {
  constructor(readonly result: R) {}
}
