import { Money, Quantity, type SubmitBillResult } from '@shopos/core'
import { belowCostLines, belowCostMessage } from '../../ui/belowCost'

/** What the cashier is told when a bill cannot be taken, and what to do about it. */
export function submitMessage(result: Extract<SubmitBillResult, { ok: false }>): string {
  switch (result.code) {
    case 'INSUFFICIENT_STOCK': {
      const first = result.shortfalls[0]
      // This shop has chosen to refuse. Said with the way out, because a cashier
      // who cannot sell the item in the customer's hand needs to know it is a
      // setting and not a fault.
      const how = ' This shop refuses sales below the count — an owner can change that in Settings.'
      return first
        ? `Not enough stock: ${first.productName} has ${Quantity.formatQty(first.available)}, needs ${Quantity.formatQty(first.required)}.${how}`
        : `Not enough stock.${how}`
    }
    case 'CREDIT_LIMIT_EXCEEDED':
      /* Checked against what this till knows. Two tills apart can each give
         credit up to the limit, so the shop's figure may already be higher. */
      return `Over the credit limit by ${Money.formatWithSymbol(result.excess)}, going by what this till knows. `
        + 'Take a payment first or reduce the bill.'
    case 'PAYMENT_MISMATCH':
      return 'The payment does not match the bill total.'
    case 'INVALID_PAYMENT':
      return 'A payment has to be more than zero.'
    case 'CREDIT_WITHOUT_CUSTOMER':
      return 'Choose a customer before billing to credit.'
    case 'LOYALTY_REJECTED':
      return `Points could not be redeemed: ${result.reason}.`
    case 'SHOP_STATE_UNSET':
      /* The setting decides CGST+SGST against IGST on every bill, and with it
         unset every sale is taxed as a local one — including one to another
         state. Said as a thing to go and do, with where. */
      return 'This shop has not said which state it is in, and that decides the tax on every bill. '
        + 'Settings → Shop → State.'
    case 'NEEDS_RECIPIENT':
      // Rule 46(f). A required field, not a stopped till: put a name on it.
      return `A bill of ${Money.formatWithSymbol(result.threshold)} or more has to carry the customer’s `
        + `name and address — this one is ${Money.formatWithSymbol(result.grandTotal)}. `
        + 'Choose a customer, or add them, and take the payment again.'
    case 'BELOW_COST':
      // Reached by somebody who may not go ahead, or who said no; see `ui/belowCost.ts`.
      return result.mayAllow
        ? `Not taken: ${belowCostLines(result.lines)}. Take the discount off, or go ahead when asked.`
        : belowCostMessage(result)
    default:
      return 'The bill could not be completed.'
  }
}

/** Why the bill on screen never became a draft, by the code its save came back with. */
export function unsavedMessage(reason: string): string {
  switch (reason) {
    case 'RATE_NOT_THE_RULE':
      return 'A rate on screen is not the shop’s price for that line’s unit and quantity, so the bill was not '
        + 'saved. Change the line’s quantity or unit again to reprice it, or type the rate.'
    case 'OPEN_PRICE_NEEDS_AMOUNT':
      return 'A loose item on the bill has no amount. Type what the customer pays for it in its rate box.'
    default:
      return 'The bill on screen could not be saved, so it cannot be taken yet. Check the lines and try again.'
  }
}
