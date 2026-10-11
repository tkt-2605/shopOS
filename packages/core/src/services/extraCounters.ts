import type { SqlDriver } from '../db/driver.js'
import { entitlement, type EntitlementOptions } from './licence.js'
import { allowsAny } from '../domain/licence.js'
import { tillRole } from './sync/layout.js'

/*
 * When the plan for several counters ends, the extra counters stop taking
 * money, and the main counter goes on as a Free shop does.
 *
 * Decided by the owner on 27 September (`licensing-and-accounts.md`, *When
 * paid time ends, the shop becomes a Free shop*). The danger was never sync
 * stopping; it is counters that go on billing apart, which is how stock and
 * the credit book split without anybody seeing it. So the first rule is
 * restated rather than broken: **a licence never stops the shop billing** --
 * one counter always bills, with the whole shop's books -- and it no longer
 * promises that every counter bills.
 *
 * Which counter is the one that bills is the main (`sync/layout.ts`). The
 * others become view-only: looking up, reprinting and reports go on, and
 * they keep syncing both ways so what they show stays current and nothing a
 * person does there is stranded. What stops is *starting* a money document --
 * a bill, a return, a payment, a cash movement, a drawer opened. A bill
 * already open may be finished.
 *
 * Never part-way through a day: a licence's state is worked out per business
 * day (`stateOf`), so a till that could bill this morning can bill until the
 * day changes. Grace counts as paid. A renewal or a Business licence pasted on
 * any till reaches the others the way every setting does, and lifts this.
 */

export class ViewOnlyTillError extends Error {
  readonly code = 'VIEW_ONLY_TILL'
  constructor() {
    super(
      'This till is view-only: the plan for several counters has ended. Bills are taken at '
      + 'the main till. Renewing the plan, on any till, lets this one bill again.',
    )
    this.name = 'ViewOnlyTillError'
  }
}

/**
 * Whether this till may start a money document.
 *
 * Always, for the main and for a till on its own, which between them are every
 * till in a shop with one counter. A till that syncs through a main may while
 * the shop holds the plan for several counters, in grace included. Tills
 * paired before there was a main keep billing as they always did: nobody has
 * chosen which of them is the counter that goes on, and choosing for them by
 * accident would be worse than not choosing.
 */
export async function mayTakeMoney(db: SqlDriver, opts: EntitlementOptions = {}): Promise<boolean> {
  if (await tillRole(db) !== 'till') return true
  /* Only a licence that was read and has run out stops a counter. One this
     till could not check -- a build without keys, a webview without Ed25519
     -- is not evidence the shop stopped paying, and a licence failing never
     stops a shop taking money. So it fails open here, as the licence was
     always meant to; the counters a shop has paid for are not at the mercy
     of a webview update. */
  try {
    const held = await entitlement(db, opts)
    return allowsAny(held.grants, 'multiTill') || held.problem === 'NOT_CONFIGURED'
  } catch {
    return true
  }
}

/** Refuses, with a sentence a screen can show, when `mayTakeMoney` says no. */
export async function requireMayTakeMoney(db: SqlDriver, opts: EntitlementOptions = {}): Promise<void> {
  if (!(await mayTakeMoney(db, opts))) throw new ViewOnlyTillError()
}
