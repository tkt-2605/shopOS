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
