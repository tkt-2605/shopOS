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
  '0.4.8': {
    title: 'Every item in Inventory, costs with or without GST, and a fuller stock count',
    points: [
      'Inventory now lists every item, not only the first 200.',
      'The Cost column in Inventory has an Excl. GST / Incl. GST switch. It is the same switch as the cost price on an item and in Stock In, and the till remembers it.',
      'A new count sheet includes items the system thinks are at zero, so stock that was never entered can be counted.',
      'Searching an open count sheet also shows items that are not on it, with Add to this count beside each one. An item added to the shop after the sheet was opened can be counted this way.',
    ],
  },
  '0.4.7': {
    title: 'Rename the unit an item is counted in',
    points: [
      'Editing an item now shows its Unit, with a Rename button beside it. Rename changes only the word, for example piece to pcs. Stock, prices and the books stay exactly as they were.',
      'The item\'s price list prices, quantity breaks and customers\' own prices move to the new word. Old bills keep the word they were written with.',
      'A held bill, an old quotation or an old price file that still says the old word goes on working.',
      'What an item is counted in cannot change. To sell it by the box as well, add the box under Units it also sells in.',
      'Update every till to this version before renaming any unit.',
    ],
  },
  '0.4.6': {
    title: 'One normal price per item, a plainer Special Prices, and box prices with their own MRP',
    points: [
      'An item has one normal price: its selling rate. If an item also had an older "price on the shop\'s list", Inventory asks you once which one to keep. Keeping the shop list price changes nothing for customers.',
      'Special Prices has two tabs. Price lists: pick a list, see who is on it, and add or change its items in place. One customer: as before. Export to CSV and Import from CSV move price lists and quantity breaks in and out of Excel.',
      'Box prices and MRP, in Settings, Features: a box can have the MRP printed on it and its own price, on the item\'s units. Off, a box is priced as its pieces, and box prices already saved are kept but not charged until it is turned back on.',
      'A box line on the bill now prints the box\'s MRP, not one piece\'s, so the customer\'s saving shows.',
      'Start without them now stays started on the main till. An export already open in Excel is saved beside it as (2) instead of failing.',
      'Update every till in the shop to this version. Tills on 0.4.5 stop syncing with it until they are updated too.',
    ],
  },
  '0.4.5': {
    title: 'Receive a purchase order as it actually came, and a signature on the A4 invoice',
    points: [
      'Receive into stock on a purchase order now opens Stock In with the order filled in. Change each quantity to what came, add batch, expiry, MRP and the supplier\'s bill number, and post. The order is marked off by what came, and the rest stays open.',
      'One item can come in two batches: add it again. An item the order did not ask for can go on the same bill.',
      'When the supplier is not sending the rest, open the order and press Close short. Give a reason; nothing is added to stock.',
      'Upload your signature in Settings, Shop, beside the logo. It prints on the Authorised signatory line of the A4 invoice on every till.',
      'Update every till in the shop to this version. Tills on 0.4.4 stop syncing with it until they are updated too.',
    ],
  },
  '0.4.4': {
    title: 'Quotation rates you can see, and the round off on every bill',
    points: [
      'On a quotation or sales order, a blank rate now shows, in light grey, the price it will be filled with: the customer\'s own price or price list, or the shelf rate. Type over it to quote something else.',
      'The Roughly total on a quotation uses those same prices.',
      'A bill opened from Bills now shows its Round off line, as the receipt does. Rounding is set in Settings, Tax & billing.',
    ],
  },
  '0.4.3': {
    title: 'Quicker HSN and GST, and prices typed with or without GST',
    points: [
      'Adding an item, type its name and the HSN and GST of items you already have with that name are offered: a new brand of scissors offers your other scissors. One click fills both.',
      'Type an HSN code and GST fills in at the rate your other items with that code carry. You can still change it.',
      'Selling rate and Cost price on an item each have an Excl. GST / Incl. GST switch, and the line under each box shows the same price the other way.',
    ],
  },
  '0.4.2': {
    title: 'Edit draft quotations, see every Stock In, and safer main till changes',
    points: [
      'A draft quotation, sales order or purchase order now has Edit: change it and press Save draft. It keeps its number until you issue it.',
      'Stock In has a Past entries tab: every purchase, opening stock, adjustment and wastage, with filters for dates, kind, supplier and a search box. Click one to see its lines.',
      'Changing which till is the main no longer leaves both tills waiting for each other, and a customer is never emailed the same invoice twice after the main changes.',
      'Other tills now lists each till by its counter name, and the line under a bill says when the main till will email it, or that the shop has no main till yet.',
      'A wrong Gmail app password now says so, with where to make a new one, instead of a connection error.',
      'A Stock In saved with no cost is no longer reported as missing from the books.',
    ],
  },
  '0.4.1': {
    title: 'The MRP on every line of the bill',
    points: [
      'The bill now has an MRP column beside the rate: the printed price for the unit being sold, or the batch\'s when you chose one.',
      'A rate above the MRP shows in red, so it can be fixed before the bill is paid.',
    ],
  },
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
