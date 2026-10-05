/**
 * "The same again."
 *
 * A customer comes back for the list they bought last month; a school reorders
 * the same twelve things every term. Typing it out a second time is both slow
 * and how a line gets missed.
 *
 * The bills screen hands a request over, the shell switches to the counter, and
 * the billing tabs pick it up and build a new tab from it. A module-level slot
 * rather than a context: the billing screen is not mounted when the request is
 * made, so there is nothing to pass a prop to.
 *
 * What carries over is **what was bought** — item, unit, quantity — and the
 * customer. What does not carry over is the price. A bill from March must not
 * sell at March's rates; every line is re-priced at today's, through the same
 * resolver the counter always uses. The quantities are the starting point and
 * every one of them is still editable before anyone pays.
 *
 * The one exception is an order. A quotation or a sales order arrives here with
 * its rates attached and they are kept, because the shop promised them — which
 * is the opposite of the rule above and for the opposite reason: an old bill is
 * a record of the past, while an order is a promise about now. Such a request
 * also names the order, so the draft can carry it and paying can mark it off.
 */

export interface RepeatLine {
  productId: string
  saleUnit: string
  /** Display units, as they were billed. */
  qty: number
  /**
   * The rate to keep, in paise. Present only on an order, where it is the price
   * that was promised; absent on a repeat, which is re-priced at today's.
   */
  rate?: number
  /** Whether that promised rate has the tax in it, as the order quoted it. */
  includesTax?: boolean
}

export interface RepeatRequest {
  /** For the message that says where the tab came from. */
  docNo: string
  customerId: string | null
  lines: RepeatLine[]
  /**
   * The order being billed, when that is what this is.
   *
   * Rides on the draft as `bills.converted_from` until the bill is submitted,
   * which is the moment the order is marked off. Loading a cart promises
   * nothing; taking the money is the delivery.
   */
  order?: { id: string; docNo: string } | null
}

let pending: RepeatRequest | null = null
const listeners = new Set<(request: RepeatRequest) => void>()

/** Asks for a tab. Returns nothing: the counter decides what it can do. */
export function requestRepeat(request: RepeatRequest): void {
  pending = request
  for (const listener of listeners) listener(request)
}

/**
 * Claims the outstanding request, if there is one. Claiming clears it, so a
 * billing screen that mounts twice — React's strict mode does exactly that —
 * cannot open the same bill as two tabs.
 */
export function takeRepeat(): RepeatRequest | null {
  const request = pending
  pending = null
  return request
}

export function onRepeat(listener: (request: RepeatRequest) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
