import { Money, Quantity, type SubmitBillResult } from '@shopos/core'

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
      return `Over the credit limit by ${Money.formatWithSymbol(result.excess)}. Take a payment first or reduce the bill.`
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
    default:
      return 'The bill could not be completed.'
  }
}
