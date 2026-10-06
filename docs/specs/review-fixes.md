# Review fixes — 4 October 2026

The architecture review of 4 October found two defects, five places where the
business logic departs from how an Indian shop's books are conventionally kept,
and a handful of structural and process items. This is the order they are
fixed in and why. Each step lands with its tests, and `npm test` and
`npm run typecheck` are green before the next one starts.

## The order, and why it is this order

| # | Segment | Item | Why here |
|---|---|---|---|
| 1 | Defects | A held bill paid after its drawer closed puts the cash in the closed drawer | Reproduced; money missing from two counts |
| 2 | Defects | A held bill keeps the day it was started, but is numbered on the day it is paid | Reproduced; FY 25-26 date on a 26-27 number |
| 3 | Defects | `submitBill`'s checks read outside the transaction that acts on them | Same function as 1 and 2; one rewrite, not three |
| 4 | Business | Books closed through a date: nothing on or before it is cancelled, amended or posted | Every later step (ledger, purchases) has to respect it, so it exists first |
| 5 | Architecture | Permissions enforced in the services, not only by hiding buttons | Before new services are written, so they are born checked |
| 6 | Business | GST compensation cess | Changes the tax arithmetic every later report reads |
| 7 | Business | Prices that exclude tax, per price list | Same arithmetic; done while it is open |
| 8 | Business | GSTR-1 in its own sections: B2B, B2CL, B2CS, CDNR, CDNUR, HSN summary, document summary | Reads 6 and 7 |
| 9 | Business | The general ledger: chart of accounts, append-only GL entries posted with every document | The books every remaining figure reconciles to |
| 10 | Business | Purchases as supplier bills: invoice number and date, input tax, what is owed; supplier payments | Posts into 9 from its first day |
| 11 | Architecture | Core's public surface by module | Last, once the new modules exist |
| 12 | Process | OTP throttled per address as well as per number; app tests share a jsdom; stray prompt file moved | Independent and small |

## Decisions taken while planning

- **The drawer guard is in the service, not a trigger.** A trigger refusing a
  movement into a closed session would also refuse another till's movements
  arriving by sync after that till closed its own drawer.
- **The invoice date is the day it is issued.** A held bill is re-dated to the
  day it is paid, and numbered from that same day. Rule 46 asks for the date of
  issue; a draft is not issued.
- **Books closed is a date, not a flag per month.** One setting,
  `books_closed_through`, which replicates. It may not be set to today or later:
  a shop cannot close the day it is still trading. Sync applies rows rather than
  calling services, so a till that cancels something before it has heard of the
  lock is not stopped by it — the same limit every offline rule here has.
- **Permission checks read `ENFORCED`.** The services check exactly the pairs the
  Roles screen offers, and a core test holds the two together the way
  `permissionsHonest.test.tsx` holds the screens. A refused call throws
  `PermissionError`; it is not a result code, because the screens already hide
  the button and reaching it means something is wrong.
- **Ledger entry ids are derived, not random.** `voucher/id/n`, so two tills
  posting the same document converge on one set of rows rather than two.
- **Withdrawn from the review: a context object to replace the process-wide
  device and clock.** The cloud is one database per shop, so a host never holds
  two shops' context at once, and the resolver form already covers several tills
  in one process. Rewriting every service signature would buy nothing.
- **Valuation stays in the order movements were made.** A backdated purchase
  does not re-cost the sales between its date and now; ERPNext's repost does.
  Recorded here as the trade-off it is: correct reposting across tills that sync
  later is a distributed problem, and a shop this size backdates rarely.

## What is left, and known limits

- **Nothing here is committed.** Twelve steps in the working tree, each green
  on its own; commit them as the segments above, in order.
- **Migrations 063 and 065 are breaking.** A shop with two tills updates both
  before they sync again. Released builds (0.1.x) are at 062.
- **The cash account is the drawer's**, not the cash in the building: an
  opening float and takings banked are not recorded anywhere yet.
- **Supplier payments by cheque** are recorded as UPI/bank: widening
  `payment_entries.method` means rebuilding the table.
- **A purchase order received into stock carries no tax.** It is the goods
  received; the supplier's bill against it is not matched to it yet.
- **Purchase returns (debit notes)** are not built.
- **Two tills correcting one supplier's carried-over balance while apart**
  post two different ledger vouchers under one id; the second is quarantined
  and shown, not merged. Rare, and visible when it happens.
- Not run here: the Rust tests and the hand checks in `hand-checks.md`. No
  Rust was changed.

## State

| # | State | Where |
|---|---|---|
| 1–3 | **Done.** `submitBill` asks everything inside its transaction, dates and numbers the bill from the moment it is paid, and posts the money to the drawer open then; `postCashMovement` throws `CashSessionClosedError` rather than post into a counted drawer | `billing/submit.ts`, `billing/tender.ts`, `cash.ts`, `heldOverNight.test.ts` |
| 4 | **Done.** `books_closed_through`, set on Settings → Tax. Refuses cancelling a bill, return, payment, stock entry or count dated in it, and posting a backdated entry, count, PO receipt or opening balance into it. Never refuses today's bill, return or payment | `services/books.ts`, `BooksCard.tsx`, `booksClosed.test.ts` |
| 5 | **Done.** `requirePermission` in 70 service entry points, read from the database each time. `ENFORCED` gains `settings.write` (closing the books). A held bill's typed rate carries over for a cashier; a new one asks for `price_list.write`. The first administrator alone may be made with nobody signed in. `processReturn` moved to `returns/process.ts` to keep the fan-out under the limit | `integrity/permissions.ts`, `servicePermissions.test.ts`, `permissionsHonest.test.tsx` |

| 6–7 | **Done.** Migration 063 (breaking): `products.cess_rate_bp`; `price_lists.rates_include_tax`; on `bill_items` and `document_items` the cess rate, the cess amount and `rate_includes_tax`; `sales_return_items.cess_amount`. The mode is per line, not per bill, because a cart can hold rates from two lists. `line_total` keeps its meaning everywhere -- tax included -- so returns, loyalty, the khata and reports did not change. Cess is on the product form, the counter, both printed formats, credit notes and the GST tab; "before tax" on the price list screen, the cart and the printed rate | `domain/tax.ts`, `domain/billTotals.ts`, `repos/pricing.ts`, `cessAndRatesBeforeTax.test.ts` |

| 8 | **Done.** GSTR-1 in its sections -- B2B, B2CL (by the threshold of the invoice's own date: ₹2.5 lakh to July 2024, ₹1 lakh after), B2CS net of its credit notes, CDNR, CDNUR, the HSN summary split B2B/B2C, and the document summary -- as one CSV per section in the offline tool's columns, for the whole shop. "Export GSTR-1" on the GST tab | `domain/gstr1.ts` (pure), `repos/reports/gstr1.ts`, `gstr1.test.ts` |
| 9 | **Done.** Migration 064 (additive): `gl_entries`, append-only, replicated like `batch_movements`, ids derived from the document. The chart is code (`domain/ledger.ts`). Every submitted bill, return, payment, stock entry, drawer close and payout posts balanced lines in its own transaction; a cancellation posts the mirror, with stock taken from the actual reversing movements so the stock account equals the stock ledger to the paisa. `postMissingGl` fills in the books on opening (whole shop) and after a merge (only what arrived). Reports → Books: profit and loss, balance sheet, and the checks | `services/ledger.ts`, `services/ledger/`, `repos/ledger.ts`, `generalLedger.test.ts` |
| 10 | **Done.** Migration 065 (breaking): a purchase entry is the supplier's bill -- their invoice number and date, GST and cess per line on a cost that stays before tax, their rounding, and `invoice_total`; backfilled for purchases already posted, and frozen once posted. A registered shop's input tax goes to input credit; a composition or unregistered shop's goes into the cost of the goods. What is owed is worked out (carried over + bills − payments), the list sorts by it, and `paySupplier` records a payment. The books carry each supplier at exactly that figure. Stock In takes the bill; Suppliers shows "Owed now" and Pay; the GST tab exports the purchase register with the input tax to claim | `services/purchases.ts`, `services/payables.ts`, `repos/reports/purchases.ts`, `payables.test.ts` |
| 11 | **Done.** `index.ts` split into seven area barrels under `src/api/` -- foundation, sync, catalog, sales, stock, books, shop -- each published as `@shopos/core/<area>`. The root re-exports all seven: the same 443 exports, the same objects, checked before and after. The architecture test now holds a barrel to re-exporting only, and every area to being published | `packages/core/src/api/`, `package.json`, `architecture.test.ts` |
| 12 | **Done**, with one withdrawn. The portal limits sign-in codes to 20 an hour per address as well as per number (`auth/throttle.ts`). The stray prompt file is in `docs/prompts/`. **Not done: `pool: 'vmThreads'` for the app's tests** -- tried, slower here and it breaks the licence card's signature tests; the reason is in `vitest.config.ts` | `apps/portal/src/auth/throttle.ts`, `vitest.config.ts` |

Side findings while doing these:

- **The sync floor was one migration too high.** `MIN_PEER_SCHEMA_VERSION`
  was one past the last breaking migration, which keeps out a till that has
  already run it. Harmless until the newest migration was breaking; then a
  shop could not sync with itself. It is now the last breaking migration.
- **`amendBill` called every line a cashier's override.** It passed the
  original rates as typed rates, so the amendment recorded `manual_override`
  against the wrong person -- and, once services checked roles, would have
  refused a cashier who may amend but not set prices. It now carries each
  rate with its original source and tax mode.
- **The counter showed "Tax included" on a composition shop's bill**, worked
  out from the item rates the bill does not charge. The screen now zeroes the
  rates the way the service does.
- **The quotation and purchase order screen said "Before tax"** under typed
  rates the service read as tax-inclusive. A purchase order's typed rate is
  now before GST, as suppliers quote; a quotation's is read the way the
  customer's list quotes.
- **The app's tests aliased `@shopos/core` by prefix**, so a screen importing
  an area subpath would have resolved to `index.ts/<area>` under test while
  building fine. The areas are aliased before the root now.
- **A ledger posting that does not balance throws at submit** and so refuses
  the document. The backfill after a merge does not throw: a document from
  elsewhere whose own figures do not add up is reported in the merge's
  "left for a person" count and skipped, so one bad row cannot stop a shop's
  sync.
- The two benches: the report parity recording was re-made, and the only
  difference is the new `cess: 0` on the two GST reports; the schema-skew
  test now picks an additive difference in whichever direction one exists.

- `addDays` said it counted backwards; it counts forwards. Comment corrected.
- The synthetic shop's parity bench took returns as the cashier who rang the
  bill up. The seeded Cashier role may not take returns; the bench now takes
  them as the owner, which is what the services enforce.
- The Stock In page never checked `stock_entry.submit`. Its button now does.

## Found on the sync rerun after 0.2.1

- **A till joining a shop posted its own books, and the shop refused them.**
  After the feed is pruned, a joining till (or one back from past the feed
  lease, or one restored from a backup) is sent the shop table by table: bills
  and purchases, then the stock ledger, then `gl_entries`. The merge worked out
  the entries for each document as it arrived, before its stock movements, so a
  purchase posted all its value as adjustment and a sale no cost. When the real
  entries arrived under the same ids, the append-only guard refused them on
  both tills; they were set aside and the two sets of books differed for good.
  Reproduced at batch sizes 2, 3, 4 and 6; a real shop's 200 against thousands
  of bills hits it every time. **Fixed:** the merge no longer works the books
  out. No till that can sync lacks a ledger (the floor is 065, above 064, and a
  test holds it there), so entries always travel with their document.
- **Filling in the history ran on every opening**, so a till closed halfway
  through joining would do the same on its next start. It now runs once per
  database (066, additive: `sync_state.ledger_filled`, which never travels).
- **Two tills filling in the same history were told an edit was dropped**, once
  for every line: the rows were identical but for `created_at`. A shape may now
  name such columns (`incidental`); `gl_entries` names `created_at`.
- A till still on 0.2.0 or 0.2.1 keeps the old merge until it is updated.
  Update every till in the shop before adding a new one.

`syncLedger.test.ts`.

## The test gaps 0.2.3 exposed, closed

The counter charged one pack's price for a box of fifty while every pricing
rule was proved in core: the tests priced bills through the service, and the
screen -- which works the rate out itself and hands it over as decided -- had
none. The same shape as the sync ledger bug: a well-tested part used in an
order the tests never produced.

1. **The counter, driven.** `apps/pos/test/counterFlow.test.tsx` renders the
   billing page over a real database, scans, changes the unit and the
   quantity, pays, and holds the stored bill to the shop's prices. Fails on
   the 0.2.2 screen.
2. **The service checks a resolved rate.** A line that says its rate came from
   the shop's prices must match them for its unit, quantity and customer
   (`RATE_NOT_THE_RULE`, `billing/price.ts`). A line the draft already holds
   unchanged carries over, so a held bill keeps its quote; an amendment says
   it carries its original's (`carriesRates`). `rateNotTheRule.test.ts`.
3. **Sync in any order, every document.** `syncInAnyOrder.test.ts` sends a
   month of trade (`monthOfTrade.ts`: every document the books post) one, three,
   seven and two hundred records at a time, as it happens and to a till that
   joins after the feed was pruned, and asks for the same shop on both.
   **It found a bug:** a bill whose corrected copy arrived a batch ahead of a
   return's cancellation had its returned quantity raised by the merge for the
   undone return, and never lowered -- that till refused a return the rest of
   the shop would take. A line may now come down by the quantity of a return
   whose cancellation has just arrived, never below its submitted returns
   (`returns/reconcile.ts`).
4. **A cashier bench.** `tools/virtual-till/test/cashier-edits-lines.test.ts`
   walks the counter's own cart code (`billCarts.ts`) through seeded random
   cashier steps -- scan, rescan, change unit, retype quantity, choose the
   customer, type a rate, hold across a price change -- and holds every bill to
   the screen and the screen to the prices. Without the re-pricing, every seed
   fails, refused by (2).

## Telling the shop what does not add up

Asked by the owner: a customer returns one shirt at two counters while they
cannot reach each other, both refund it, and they sync. Both refunds stood,
the stock showed the shirt back twice, the returned quantity was clamped in
silence, and nothing said so. No counter can refuse what it cannot know about;
the shop has to be told afterwards -- about this and every other thing of the
kind.

`findDiscrepancies` (`services/discrepancies.ts`, checks in
`discrepancies/checks.ts`) reads the shop and lists, in a shopkeeper's words
with what to do and the money at stake:

- an item taken back more times than it was sold (both credit notes, who took
  each, what was over-refunded);
- an order billed for more than was ordered;
- stock below zero;
- a customer past their credit limit;
- figures the merge left out of line with their records;
- the books: entries that do not balance, the stock account against the stock
  ledger, submitted documents with no entries;
- edits dropped and records set aside by sync.

The till asks at start and after every sync round that brought something in
(`core/discrepancyWatch.ts`). A banner on every screen, for whoever may open the
dashboard, says how many and the money; the dashboard's "Needs attention" lists
each with a Seen button. Seen is kept per till (067, `discrepancies_seen`,
which never travels) and per set of facts: a new refund of the same line, or a
new document out of the books, is told again. A clean month of trade reports
nothing. `discrepancies.test.ts`, `needsAttention.test.tsx`.
