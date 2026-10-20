/*
 * What changed in each version, in the words of the people who use it.
 *
 * Shown once on each till after it updates (`ui/WhatsNew.tsx`), never after a
 * fresh install. `tools/release.ts check` refuses to tag a version that has no
 * entry here, so a release cannot go out without saying what it does.
 *
 * Written for a shopkeeper: what they will notice and what to do differently,
 * not what the code does. Three to six points; the first is the one that
 * matters most.
 */

export interface ReleaseNote {
  /** One line: the headline of this release. */
  title: string
  points: string[]
}

export const RELEASE_NOTES: Record<string, ReleaseNote> = {
  '0.4.0': {
    title: 'Cost prices, and nothing sold below cost by mistake',
    points: [
      'Nothing can be sold, or priced, below what it cost. A bill, an item\'s rate, a price list rate or a delivery\'s selling price under cost is stopped and says which item and by how much. The owner can go ahead anyway, and it is recorded.',
      'The bill discount can now be a percentage: switch between ₹ and % beside it. The totals warn while you type if the discount takes an item below cost.',
      'An item has a cost price, set when you add it, and Inventory shows each item\'s latest cost beside its rate. Stock In and purchase orders start each cost at the last price paid. An item with no GST is now one tick, No GST.',
      'Type a cost before GST or with GST: the Excl. GST / Incl. GST switch above the cost shows the same cost the other way, and the till remembers which you use.',
      'New in Settings, Features: One item per barcode. On, a barcode another item has is refused. Codes already on two items are listed there, with a button to take each off the item that should not have it.',
      'Reports to support now go by the shop\'s email instead of Telegram.',
    ],
  },
  '0.3.2': {
    title: 'Bills emailed to your customers, and simpler report settings',
    points: [
      'Tick "Email every bill to this customer" on a customer, and the main till emails them each bill as the A4 invoice in a PDF. The bill shows whether it went.',
      'The shop\'s email is now set up once, under Settings, Shop details, with a button that sends a test so you know it works.',
      'Send reports no longer asks for a bot token, a chat id or a mail server. It shows where reports go, has a send button for each, and lists anything still waiting and why.',
      'The "Short by" warnings that stayed on the tills after a sync are gone.',
    ],
  },
  '0.3.1': {
    title: 'Bills emailed to the customers you choose',
    points: [
      'Tick "Email every bill to this customer" on a customer, and the main till emails them each bill as the A4 invoice in a PDF.',
      'A bill shows whether it was emailed, and if it could not be, says why and has a Try again button.',
      'The "Short by" warnings that stayed on the tills after a sync are gone; they were counting a till\'s own changes coming back to it.',
      'A customer file with an email that is not one plain address is refused on that row, like a wrong GSTIN.',
    ],
  },
  '0.3.0': {
    title: 'One main till, and help when something goes wrong',
    points: [
      'One till is now the main till, and the other counters sync through it. Keep the main till switched on while the shop is open.',
      'A counter can change which counter it bills on only while the main till is on, so two tills can never give out the same bill number.',
      'When a till opens, it catches up with the main till first, and shows a short wait while it does.',
      'If something is done twice on two counters, such as a bill paid twice, Needs Attention now has a button to cancel the one that should not have happened.',
      'Get help, at the bottom of the menu, shows your support code and lets you message support on WhatsApp or let them see the screen.',
      'An owner can now send the shop\'s records to support, locked so only support can open them, and apply a fix support sends, from Settings, Help.',
    ],
  },
  '0.2.21': {
    title: 'Fixes for tills that were apart',
    points: [
      'A return entered on one counter before the sale reached it is no longer lost when the two meet again.',
      'Reports sent to Telegram now carry the shop\'s health for support, and never customer details.',
    ],
  },
}

export function notesFor(version: string): ReleaseNote | null {
  return RELEASE_NOTES[version] ?? null
}
