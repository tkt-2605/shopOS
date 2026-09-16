import { isStateCode } from './states.js'

/**
 * A GSTIN, and the state it says the holder is registered in.
 *
 * Moved out of `shop.ts` because the customer needs the identical rule and had
 * none. The shop's GSTIN has been shape-checked and cross-checked against its
 * chosen state since v1; a customer's was stored exactly as typed, and the
 * state that decides CGST+SGST against IGST was the literal `'33'` that
 * `customers.ts` wrote into every INSERT. One copy of the rule, in `domain/`,
 * used by both.
 */

/**
 * 15 characters: two state digits, a ten-character PAN, an entity number, a
 * fixed Z, and a checksum character.
 *
 * The shape is checked and the checksum is not. A shop typing its own GSTIN off
 * its own certificate is not the threat model, and a checksum rule that
 * rejected a number the government itself issued would be the software telling
 * the shop its registration is wrong.
 */
export const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/

export function isGstin(value: string | null | undefined): boolean {
  return typeof value === 'string' && GSTIN_SHAPE.test(value)
}

/**
 * The state a GSTIN belongs to, from its first two characters.
 *
 * Null rather than a guess when the number is not a GSTIN at all, or when those
 * two digits are not a state anybody is registered in — `00` and `99` are
 * neither, and a half-typed number passes through here on its way to being
 * finished. A caller that took the first two characters unconditionally would
 * write `00` into a place-of-supply field and print it on an invoice.
 */
export function stateFromGstin(gstin: string | null | undefined): string | null {
  if (!isGstin(gstin)) return null
  const code = gstin!.slice(0, 2)
  return isStateCode(code) ? code : null
}

/**
 * What a customer's state should be, given what is known about them.
 *
 * The order is the point. A GSTIN is the registered fact and outranks
 * everything: a customer who hands over a `27…` number is in Maharashtra
 * whatever a form says. An explicit choice comes next, because somebody typed
 * it. The shop's own state is last, and only as a default for a walk-in with
 * no GSTIN — which is the common case in a counter shop and is right far more
 * often than it is wrong.
 *
 * Returning null is allowed and means "nobody has said". That is honest, and
 * `supplyTypeFor` already treats an unknown state as intra-state, which is the
 * safe reading: it charges CGST+SGST, which is what a local sale owes.
 */
export function resolveCustomerState(input: {
  gstin?: string | null
  chosen?: string | null
  shopState?: string | null
}): string | null {
  const fromGstin = stateFromGstin(input.gstin)
  if (fromGstin !== null) return fromGstin
  if (isStateCode(input.chosen)) return input.chosen!
  if (isStateCode(input.shopState)) return input.shopState!
  return null
}
