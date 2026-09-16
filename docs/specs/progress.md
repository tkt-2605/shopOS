# Progress

Branch `phase-2-foundations`, 30 commits ahead of `main`, pushed to
`origin/phase-2-foundations`. Not merged to `main`, and nothing is released: no
installer, no tag, no update anybody's till will fetch.

`tools/fixtures/` is gitignored as a folder and no `.db` is tracked. **The
fixture in it is dummy data** -- the owner confirmed on 16 September 2026 that
it can be erased or reshaped freely. See the note under "What the fixture
changed"; it is not the constraint earlier rows of this file treated it as.

State of the tree: **1,480 TypeScript tests** passing and **none skipped** --
the three Phase 2c placeholders are real tests now -- across 110 files, **111
Rust tests** passing with a clean build, typecheck clean across core, app and
both bench packages, and Layer 2 of the test bench green in Docker. Schema at
35.

---

## Done

### Row 0 — before any code

| Item | State |
|---|---|
| `tools/pull-shop-db` | **done**, run against the real shop |
| OV certificate | **not started — owner's, 1–3 weeks** |
| Updater keypair | **not started — owner's, one hour** |

### Row 1 — Phase 0, stop the bleeding

All eight rows of `phase-0-spec.md`. `synchronous = FULL`; the carry-off hook's
result stored and shown red; the daily backup's failure shown on the card and
as a mark in the top bar; the backup listing throwing instead of answering `[]`
for a folder it cannot read; an error boundary inside `main` so a crashed page
keeps the sidebar; `app_version` from Rust with the schema from
`PRAGMA user_version`; a 02:00 timer beside the on-open run; `noUnusedLocals`
and `noUnusedParameters` on with fourteen symbols deleted.

Four checklist items still need the app running by hand — see *Left* below.

### Row 2 — the test bench

All three layers.

- **Layer 1**: `tools/virtual-till`, seven scenario files, 30 tests, under three
  seconds, inside `npm test`.
- **Layer 2**: three containers on two Docker networks. Discovery filtered by
  network, and a host-initiated sync across namespaces. Passing; output kept at
  `evidence/layer2-passing.txt`.
- **Layer 3**: written procedure at `layer3-procedure.md`.
- `crates/shopos-net` extracted, workspace created, the app depends on it.
- `bench-layer2.yml`: nightly and dispatch, never required, with a broadcast
  smoke test that exits 0 and says "self-hosted only" rather than going red on
  a runner that cannot do the job.

### Row 3 — migration 028 and Phase 1a

Every item on the 1a list, and the migration under it.

- **028, the invoice snapshot.** Five columns on `bills`, two on
  `sales_return_items`. Replayed against the owner's database before anything
  trusted it, as 027 was, and kept as `migration028Real.test.ts`.
- **The snapshot is written**, at submit, by `submitBill`. The migration added
  the columns and nothing filled them.
- **Customer state.** `customers.ts` wrote the literal `'33'` into every INSERT
  and no screen could set it. Derived now, GSTIN first, with `domain/gstin.ts`
  and `domain/states.ts` shared with the shop's own rule.
- **`amendBill` carries the bill**, rather than issuing a larger one.
- **Returns in the GST export**, as credit notes, negative, against the invoice
  number -- with the 028 snapshot and the returns' own supply type underneath
  it. Verified on the owner's database: `reportsAgainstRealShop.test.ts`.
- **`round_off` on the last rate row**, so the export ties to `grand_total`.
- **`receipt.ts`** stopped dividing money by money to recover a quantity.

### Row 4 — Phase 1b, what the paper must carry

- **The place of supply was the shop's own state**, on every invoice it
  printed, including ones billed to another state and charged IGST. The
  renderer was never wrong; the thing filling it in was, and every test of the
  renderer passed throughout because they all built the document by hand. There
  is a test now that rings a bill up through the real services and renders what
  the app actually builds.
- **The sheet carries Rule 46**: recipient address and GSTIN, place of supply
  as "27 — Maharashtra", reverse charge, CGST/SGST *or* IGST columns, the rate
  per line, and a rate-wise summary. `rule46.test.ts` reads the rule as a
  checklist and asserts every clause by text.
- **The credit note**, which did not exist. A return was a stock movement and a
  row in a list; under GST it is the document, and a registered buyer cannot
  reverse the purchase without one.
- **The tax scheme**: composition and unregistered shops stop being made to
  charge tax they may not collect, the document is titled accordingly, and the
  GST reports are hidden with a sentence. See finding 11 for why the *default*
  is not what the spec asked for.
- **Migration 029**, turning the roll's title on — and taught to be silent to
  sync, which took two tries and a failing `sync.test.ts` to get right.

### Row 5 — Phase 1c, the guards

`SHOP_STATE_UNSET` and `NEEDS_RECIPIENT` at submit, `GSTIN_REQUIRED` on the
shop form, `HSN_SHAPE` as a warning on the product form, and an exceptions
sheet of B2B lines missing HSN beside the GST export.

Every one of them was checked against the owner's database before it was
written, and the check is a test: none fires on that shop today. `rule46.test.ts`
landed with 1b and covers all four documents the spec asks for.

`GSTIN_REQUIRED` bites only once a person has *answered* the scheme question,
never on the till's own guess — otherwise it would refuse the one form that
lets the owner answer it. Agreed with the owner before it was written.

### Row 6 — Phase 1d, the switches that were on and did nothing

Eight commits, one per thing. The shape repeats: a service that worked, was
tested, and that nothing in the product could reach.

| Commit | What was on and did nothing |
|---|---|
| `3332ad9` | amend on a cancelled bill; `changePassword`; group rename/remove; the schema-too-new screen, which showed the right message and then offered **Restore a backup** — to a till that is merely behind, which would have replaced what the newer version wrote |
| `28ddae1` | `closeSession` has written `expected_cash`, `actual_cash` and `variance` since v1 and nothing ever selected them. Drawer tab under Reports |
| `6caa662` | `activity_log` (written since 001, read by nothing) and `sync_queue` (reserved on day one, never held a row) dropped in 030 |
| `6d5ef1b` | `products.is_active` — the column worked and no shop could reach it, so shops renamed things to "OLD - do not use" |
| `f478ebd` | customers archive; refuses while they still owe money, with the amount |
| `9d4aba8` | `deleteSupplier` ran `DELETE FROM suppliers` under a comment saying it never removed anything, and its refusal told shops to "switch it off instead" when nothing could |
| `39dc0b5` | `price_lists` had **both** retirement columns and half a feature in each: `is_active` written and never read, `deleted_at` read everywhere and never written. 031 drops the first, `archivePriceList` supplies the second |
| `5d738e7` | `users.deleted_at` and `roles.deleted_at`, filtered by nine queries and set by none. 032 drops both |
| `dd2b948` | "Both tills agree" printed to shops with one till |
| `d156cd8` | `schema_bootstrapped_at`, a settings row in every shop that nothing asks for. 033 |

Two of these were more than tidying.

**`reauthenticate` was not checking whether you were still staff.** It selected
the user `WHERE deleted_at IS NULL` — a condition nothing in ShopOS could make
false — and never looked at `is_active`. A cashier disabled while still holding
a signed-in window could retype their password and walk into Settings. The dead
column was standing in for a real check; dropping it forced the real one.
Finding 13.

**Archiving a price list had to be taught to the resolver.** A customer keeps
pointing at an archived list, because that pointer is how restoring puts them
back on their old rates — so `pricingContextFor` checks the list where the rate
is decided. Without that, archiving would have been `is_active` all over again.

The `IN_USE` refusal on price lists is the first guard written in 1c or 1d that
**fires on the owner's shop**: one customer is on Wholesale, so Remove refuses
and names the count rather than moving them to Retail rates overnight. Finding
12.

Migrations 031–033 were each run against a copy of the owner's database:
`change_feed` unchanged at 195 rows every time, so none of them repeats 029 and
manufactures a sync conflict on rows nobody touched; `integrity_check` ok; no
foreign-key violations; 29 submitted bills and ₹27,328 unmoved. That last pair
is a test now, not a note — `reportsAgainstRealShop.test.ts` migrates the copy
to `EXPECTED_SCHEMA_VERSION` on every run and asserts the schema, the integrity
check, the supply types and the money. Every future migration re-runs it the
moment it is registered.

### Row 7 — Phase 3, a shop must not be able to lose data

**Complete.** Nine commits, taken in the order that makes each one verifiable
when it lands.

| Commit | What it stops |
|---|---|
| `481ecc0` | **The log file.** Rust and webview events in one file in one order, five files of a megabyte. `ErrorBoundary.tsx` had a `TODO(phase-3)` sitting on the `console.error` it replaces |
| `bc3be06` | **An icon that did nothing when double-clicked.** `setup()` ended in `Db::open(..)?`, so a database that would not open meant no window at all -- and `windows_subsystem = "windows"` means no console either. Plus `quick_check` at open, and advice per failure kind |
| `f0e6f93` | **A backup nobody had opened.** The archive is now read back and `integrity_check`ed before it is allowed to wear today's name, and there is a "Check" button per backup |
| `8bd13ef` | **The three things the log was supposed to catch and did not.** Migrations, the backup outcome both ways, and sync refusals from both ends |
| `494c19e` | **A support call conducted down a phone line.** One zip to send. Redaction is an allowlist, not a denylist; `users.password_hash` and `sync_peers.secret` are never read at all |
| `5b69450` | **Four bugs that only exist at size, with nothing of that size to look at.** `tools/synthetic-shop`: 20,000 bills over a year, generated and seeded, in two and a quarter seconds |
| `63d2fa7` | **"Total outstanding" was the total of the five hundred rows on the screen.** Short by ₹2,80,542.65 of ₹19,67,837.26 on a shop with 600 customers — fourteen per cent, and always in the direction that never prompts a question |
| `064418f` | **Two indexes, measured rather than guessed.** The Bills page's default view went 24.8 ms to 0.48 ms. The third index the phase asked for is not here: it would have made the one query it was for slower |
| `49216a5` | **Opening the home screen replayed the whole stock ledger.** Scoped to the products a caller names; the unbounded replay moves to the 02:00 timer, weekly |
| `6b9424a` | **One watchdog timeout for a bill and for a merge.** Per-transaction budgets, and a write outside the token refused instead of silently joining the transaction that is running |

Three things in these were worth more than their task-list line.

**`reauthenticate` was not checking whether you were still staff** (found while
dropping `users.deleted_at` in 1d, finding 13). It asked whether the user had
been deleted -- a thing nothing could make true -- and never looked at
`is_active`, so a cashier disabled mid-shift could retype their password and
walk into Settings.

**The startup screen offered the wrong way out.** Five reasons land on
`CouldNotStart` and "Restore a backup" is right for exactly one of them. A till
that is merely *behind* would have destroyed what a newer ShopOS wrote while
following the screen's own instructions; a till whose file is merely *held open*
would have thrown away everything billed since the backup to fix a problem that
ends by itself. `core/startupAdvice.ts` is a pure function with nine tests.

**The backup check catches a perfect copy of something broken.** `VACUUM INTO`
of an already-damaged database produces a well-formed zip with a correct CRC
whose every byte round-trips. Only `integrity_check` on the extracted database
notices, and it runs before the rename, so a failed archive never wears today's
name at all.

### What the synthetic shop found that a task list could not

The generator was built first so the scale work could be measured instead of
reasoned about, and it earned that on the first run.

**Two of the three indexes the phase asked for were right and the third was
wrong.** `stock_ledger(product_id, posting_date, created_at)` would have put a
column between `posting_date` and the rowid, and `productValuation` orders by
`posting_date, rowid` — so the index written to speed that query up hands it a
sort it does not currently have. The item was written from the query and not
from the schema. `idx_stock_ledger_product` is left exactly as it has been since
001.

**`audit_log(actor_id)` alone would have made the common case forty times
worse** — 0.25 ms to 9.8 ms for a cashier who rang up half the shop, because
with no ordering inside the actor SQLite seeks all 9,401 of her rows and sorts
every one to show a hundred. `(actor_id, at DESC)` keeps the rare actor's
forty-fold win and leaves the busy one alone. The plan test fails if the second
column is removed.

**The generator's own cross-check caught a real bug in a real shape.**
`product_stock` is written from a running position kept as it sells;
`recomputeStock` replays the ledger through `movingAverage`. They disagreed on
32 products: a cancelled bill was putting stock back at the product's original
cost rather than at what the sale took off the shelf, which is a silent
revaluation — the shop's books move because a bill was cancelled.

**A fixture full of tax the till would have refused to charge.** `bootstrap`
leaves no GSTIN and no state code, so the first attempt to bill against the
finished shop was refused by Phase 1c's own guard. Found because the shape test
bills through `createBill`/`submitBill` rather than asserting about rows.

### What Phase 3 changed on screens, not only underneath

- The Credit page's three headline figures are the shop's, from one query, and
  the table under them says "Showing 500 of 600" when it is short. With the
  total fixed and the table unchanged the page would have contradicted itself in
  public with no explanation anywhere on it.
- The Dashboard's "Outstanding credit" is now the same number, from the same
  function, as the Credit page's. It was its own query with its own definition:
  two screens, one label, two answers.
- The Dashboard's drift warning reads what the weekly replay found and says
  when. Inventory's repair button records what *it* found, so the warning clears
  when a person deals with it rather than at the next weekly run.
- "Report a problem" on Settings, which says in those words that nothing is
  sent.

### Row 8 — Phase 2, foundations while the installed base is zero

**Complete.** All three parts, thirty commits, one service per commit through
2a as the spec asked.

#### 2a — typed queries

`packages/core/src/db/schema.ts` is the shape of the database in a file the
compiler can read: seeded once by `drizzle-kit pull` against a copy of the
owner's migrated database, then owned by hand. `drizzle-kit` is deliberately
not a dependency -- two of its three commands write DDL at a database, and a
tool that can rewrite a shop's schema has no business being one `npm install`
away from a developer in a hurry.

Two things had to exist before a single query moved.

**Rows by position.** Drizzle's proxy hands its callback positional rows and
maps them onto the columns it asked for. The Tauri driver's rows are built in
Rust as a `serde_json::Map`, which sorts its keys -- so `SELECT b, a` arrives
as `{a, b}` and every column is off by one with plausible values in the wrong
fields. A Cargo feature would have fixed the sort until somebody upgraded a
dependency that turned it off again, and nothing would have gone red.
`queryValues` asks SQLite for positions instead, through all three drivers, and
`positionalRows.test.ts` pins it.

**Brands that survive the read.** `money()` and `qtyCol()` carry `Money` and
`Qty` through the column type, so the `paise(row.grand_total)` re-wrapping that
every repo used to do -- and that a column somebody forgot to wrap slipped
straight past -- is gone. They are casts and not conversions on purpose:
validating on read would throw on rows already in a shop's database, turning a
data problem into a till that will not open a screen.

Twenty-two services and repos moved, in the spec's risk order: `billing`,
`returns`, `payments`, `cash`, `reports`, `stock`/`stockEntry`, `pricing`,
`documents`, then the rest. Before `reports.ts` -- the file a shopkeeper files
a GST return from -- all ten reports were recorded against a year of the
synthetic shop as digests, and the harness was proved to bite by dropping the
credit-note UNION.

What stays written out is marked `// raw:` with its reason, and the reasons are
of three kinds: a window function (`reorder.ts`), a correlated subquery against
the outer row (the customer balances, the bill's returns, the supplier's
purchases, the audit log's subject), and a statement whose table and columns
are not known until run time (`sync.ts`, `changefeed.ts`'s seed). Every one of
them writes its table name out in full -- `bills.id`, not `id` -- because a
bare column inside a subquery binds to the inner table and answers about the
wrong one, which is a bug SQLite is happy to run.

Three things the conversion found that the tests had not:

- **The khata balance in `archiveCustomer` was only half tested.** The one
  settling test paid cash at the counter, which leaves `credit_total` at zero,
  so the allocation half of the subtraction could have returned anything. There
  is a test now that takes a bill on credit, sees the archive refused, records
  a receipt and sees it allowed.
- **`bootstrap` writes at head.** A typed insert names every column the table
  has, which turned up a fixture calling it against a database deliberately
  stopped at version 1. The app migrates before anything reaches `firstRun`, so
  the order is written down now rather than rediscovered.
- **The failed-sign-in counter was read and written back.** Two tills signing
  in as the same user could both read 3 and both write 4. It is incremented in
  the database now.

#### 2b — a `SqlDriver` for Turso

`libsql-driver.ts`, for Phase 6's headless till. `@libsql/client` is
deliberately not a dependency: one deployment out of three needs it, it carries
native binaries, and core is the package every test in the product builds. The
three methods this uses are written out as an interface, and Phase 6 hands in
`createClient({ url, authToken })`, which satisfies it structurally.

Its test answers libSQL's interface with a real SQLite file and then migrates,
bootstraps and sells something through it, because the question worth asking is
whether a bill submitted through this driver comes out the same as one
submitted through the node driver. Three properties are mutation-checked: a
rollback that rolls back, columns read by position, and `intMode: 'bigint'` --
a legal way to create a libSQL client that would otherwise hand a `bigint` to
arithmetic expecting paise.

#### 2c — migrations that can be rolled out

The handshake demanded that the two schema versions be exactly equal, which is
right while every till in a shop is updated by one person on one afternoon and
wrong the first time it is not: an update rolls out, the second till is
switched off, it comes back on Monday and the shop cannot sync at all with
nothing on either screen saying why.

Every migration is now classified additive or breaking in `migrationKinds.ts`
-- a module that reads nothing off disk, because `db/migrations.ts` uses
`node:fs`, the app globs the same folder through Vite, and `sync.ts` runs in
the webview where `node:fs` does not exist. `MIN_PEER_SCHEMA_VERSION` is
derived as one past the last breaking migration rather than typed next to the
list, because a number typed next to a list is a number that stops matching it.
A pair is allowed when each side is at or above the other's floor.

The bias is deliberate and written into the file: calling a breaking migration
additive lets two tills corrupt each other's books quietly, and calling an
additive one breaking refuses a sync somebody can fix. `030` is the standing
example -- it drops two tables nothing replicates and is marked breaking
anyway.

Three things that would each have undone the phase were caught:

- **`handleOffer` carried the same equality check** on the pushed batch. A pair
  would have agreed at `hello` and then had every batch refused.
- **A missing `minPeerSchema` means something specific.** A pre-2c build sends
  no field *and* refuses anything but an exact match, so absent is read as
  "they demand equality" -- which puts the refusal here, with a reason, rather
  than halfway through.
- **Both directions are checked**, because the danger is not symmetrical: the
  newer till writes columns the older has no place for, the older sends rows
  missing columns the newer has made NOT NULL. The refusal names which side is
  behind.

`applyBatch` reads every incoming row through the receiving database's own
columns, cached per table per driver, and reports `ignoredColumns` and
`ignoredTables` on the round so the newer till can say the other one is behind.
`schema-skew.test.ts` is un-skipped with six tests, one of which carries a real
bill across the version difference -- a rule that said yes and moved nothing
would pass the handshake assertion on its own.

`migrationReplay.test.ts` runs the thirty-five in order over the owner's own
database and asserts that the file is still sound, that no foreign key dangles,
and that no table came out with fewer rows than it went in with. The row counts
are an allow-list rather than a tolerance, and the tables that do move are named
separately so the exceptions cannot quietly grow.

#### The checklist

Every line of the spec's verification section is a test, and none of them needs
the app running:

| Check | Where |
|---|---|
| `schemaParity` against the real shop migrated to head | `schemaParity.test.ts` |
| `(b, a)` comes back as `[b, a]` through both drivers | `positionalRows.test.ts` |
| a Drizzle query inside a transaction goes through `sql_tx_query_values` | `positionalRows.test.ts:168` |
| `db.query`, `db.get`, `db.execute` in a converted service finds only `// raw:` | grepped at each commit |
| replay green on the real copy | `migrationReplay.test.ts` |
| replay green on the synthetic shop | `shape.test.ts:174`, which builds it by running the same migrations |
| a till at N and one at N−1 sync; a breaking one refuses | `schema-skew.test.ts` |


### Pulled forward out of order

- **Phase 1d's host-sync fix.** The bench demanded it: `host-initiates.test.ts`
  fails against the tree without it, and `npm test` may not stay red. Failing
  output kept at `evidence/host-initiates-before-1d.txt`.
- **The CGST/SGST fix**, applied on the owner's instruction ahead of Phase 1a.

---

## What the fixture changed

> **Correction, 16 September 2026.** Everything below, and all thirteen findings
> in `findings-real-shop.md`, was written about `tools/fixtures/real-shop.db` in
> the belief that it held a live shop's books. **It is dummy data.** The owner
> confirmed it can be erased or reshaped freely.
>
> What survives the correction: every one of these findings is still a true
> statement about *a database this software produced*, and each was a real bug
> or a real gap in the code. Rows 1 and 4 below are about arithmetic and are
> unaffected.
>
> What does not survive: the sentences arguing from what the shop *meant*.
> Finding 2's reasoning leaned on "29 submitted bills, every one carrying CGST
> and SGST, entered by a person who meant to" — nobody meant anything by them.
> The behaviour is still right for a different and better reason, given below.
>
> What it unblocks: row 3 and the Phase 3 scale work. Both were stalled on
> nobody feeling free to fabricate data.

`findings-real-shop.md` has thirteen findings. Four affect the plan:

1. **CGST ≠ SGST on 29 of 51 lines.** Not in any spec. Fixed. A genuine
   rounding bug, and true whoever entered the rows.
2. **Tax charged with no GSTIN set.** ~~Phase 1's scheme rule will default it to
   `unregistered` and stop charging tax.~~ **Settled** — finding 11. The
   original premise was wrong twice over: there was no screen that could save a
   GSTIN until `services/shop.ts`, so an empty field says nothing about any
   shop; and the database it was read from is fabricated, so it says nothing
   about this one either. `loadTaxScheme` stands, on the argument that does not
   depend on the data — **an upgrade must not silently change what a till
   charges**, so it weighs what the till has been doing and Settings asks.
3. ~~**This database cannot exercise the inter-state path.**~~ **Unblocked.**
   Every customer in the fixture is `'33'` and so is the shop, so
   `SUM(igst_amount)` is zero and IGST could not be exercised end to end. This
   was recorded as "has to be staged by hand" only because the file was thought
   to be untouchable. It is not, and the right fix is a test that builds the
   two-state case rather than a hand-staged copy — tests run in CI and the
   fixture does not.
4. **The dashboard's tax figure and the GST rate rows differ** by the tax on a
   credit note -- gross against net. Both honest, different questions, two
   numbers one shopkeeper will read as one. Left for the 1b/1c review.

---

## Left

### Phase 1 — the bills have to be right (code complete)

028 through 033, 1a, 1b, 1c and 1d are all done.

Two items in 1d's list came out differently from the spec, both after reading
the code:

- **`tax_reversed` stays.** The spec said drop it unless a grep finds a reader.
  `loadReturnDetail` reads it and the return sheet shows it — a reader that
  arrived with the credit-note work in 1b, so the spec was right when it was
  written and is wrong now.
- **`suppliers.is_active` stays too,** alongside the new archive. The spec
  assumed suppliers needed `deleted_at` wired and nothing else; the table
  already had a working `is_active`. They are different questions — "off" is
  not buying from them just now, "removed" is off the list — and collapsing
  them would have lost one.

#### The five hand-checks, audited

> **Correction, 16 September 2026.** This list used to say that five of Phase
> 1's eight checks had to be staged by hand on a copy of the owner's database,
> "because that database cannot exercise the inter-state path on its own — the
> shop and every customer are `33`".
>
> That reason had already been retired two sections up, when the fixture turned
> out to be dummy data and the note there says the right fix is "a test that
> builds the two-state case rather than a hand-staged copy". The list was not
> updated to match. Audited line by line below; **two are genuinely manual, two
> are tests, and one is half a test.**

| # | The check | Where it stands |
|---|---|---|
| 1 | shop in `27`; a `27` customer stores CGST+SGST, a `33` customer stores IGST, read off `bill_items` | **A test**, written during this audit: `shopElsewhere.test.ts` |
| 2 | amend a cancelled ₹900 bill; the draft is ₹900 with tax on ₹900 | **Already a test** — `amendCarries.test.ts:39`, that exact bill, to the paisa |
| 3 | the A4 print read against Rule 46's list, on paper | **Manual.** Paper |
| 4 | composition: zero tax stored, *Bill of Supply* with the Rule 49 statement, GST tab hidden | **Two thirds.** See below |
| 5 | on a real LAN with the joiner idle, the host never says "Both tills agree" first | **Manual.** A LAN |

**Item 1 needed a test nobody had written.** Every test that bills runs from
state `33`, and so did every row in the only database anybody had — which is a
trap and not a coincidence. `customers.ts` used to write the literal `'33'`, and
because the shop was *also* in `33` the fabrication and the truth coincided:
every bill came out intra-state and every bill was right by accident. The
customer half of that is disproved by a `27` customer getting IGST
(`returnsInGst.test.ts:198`). **The shop half was disproved by nothing** — until
now, no test had ever billed from anywhere but Tamil Nadu. `shopElsewhere.test.ts`
moves the shop to Maharashtra, where `33` is the *foreign* state; three of its
five assertions fail if `shopState` is pinned to `'33'`, which is how it was
checked.

**Item 4 is two thirds tested and the last third is named.** Zero tax stored
under composition is `taxScheme.test.ts:198`; *Bill of Supply* and the Rule 49
sentence are `rule46.test.ts:272` and `taxScheme.test.ts:46`. The **GST tab
being hidden is not tested.** `chargesTax()` — the rule it turns on — is;
`Reports.tsx` reading it is not, and neither is the effect at `Reports.tsx:88`
that moves a shopkeeper off the tax tab if they switch to composition while
standing on it. That is a screen-wiring gap of exactly the shape the log's
missing callers were, and closing it means the first render test of a page that
size. Left open deliberately, and written down rather than counted as done.

Everything else a terminal can check is checked.

### Phase 3 — a shop must not be able to lose data

**Done.** All eleven of the spec's file-level items, plus the synthetic shop
none of them could be verified without. Row 7 has the commits.

Four of the spec's verification lines still need the app running by hand, and
are listed under *Needs the app running* below. Everything a terminal can check
is checked, including three lines the spec wrote as manual checks:

- "the diagnostics bundle opened by hand: no token, log present, version
  present" — a test seeds three secrets, writes a real zip, reads every entry
  back the way a recipient would, and asserts none of the three appear.
  Mutation-tested: neutering the allowlist fails five tests.
- "`EXPLAIN QUERY PLAN` in a test" — eight of them, and each explains the
  statement the repo actually issued rather than a copy of it kept in the test.
- "a merge of 500 changes completes without the watchdog firing" — five hundred
  real bills with their lines against the 20,000-bill shop, under a second and
  a half against a budget of ninety.

Two things worth carrying forward rather than forgetting:

- **`sql_execute` now refuses with "a transaction is open"**, which is the right
  words for a log and the wrong words for a shopkeeper. No screen renders it
  today; when Phase 4 goes over error surfaces it should get a sentence about
  the till being busy taking in changes from the other counter.
- **Nothing runs `ANALYZE`**, so SQLite plans from fixed guesses about
  selectivity. Every plan in 034 was checked both with and without statistics
  and is the same either way, so this is not a gap in that migration — but
  whether the weekly job should start collecting them is a real question, and
  the weekly job now exists to hang it on.

### Phase 2 — foundations

**Done.** Row 8 has it. The one thing left from the spec that is not code is
the customer-buckets rehearsal, which the spec itself defers: it is Phase 5's
proof of this phase, not this phase's.

### Phase 4 — getting it onto a shop's PC (~6 days + the certificate)

CI, updater, licensing and the portal skeleton are all buildable and testable
unsigned. Only the signed release waits on the certificate.

### Phase 5 (~15 days), Phase 6 (~12 days), Phase 7

Phase 5 needs a Tamil reader to check one printed receipt. Phase 6 needs the
spike before anything else, and a VPS, a domain, object storage and the
WhatsApp paperwork. Phase 7 is deliberately deferred.

---

## Left that is not code

These are the owner's, and nothing in the next four weeks is blocked on them.
`owner-readiness.md` has the detail.

| # | Item | Blocks | Lead time |
|---|---|---|---|
| 1 | OV code-signing certificate | the signed release, Phase 4 | 1–3 weeks |
| 2 | Updater keypair | the first release, permanently | 1 hour |
| 3 | GitHub owner/repo name | the updater endpoint URL | a decision |
| 4 | Whether TRT is GST-registered | what Settings should say | a decision |

Row 4 no longer blocks anything. It was raised from the fixture, which turns out
to be fabricated; `loadTaxScheme` preserves whatever a till has been doing and
Settings asks, so a real shop is never switched off by an upgrade. It stays on
the list because a shop that is *not* registered and has been charging tax
anyway is a case only its owner can identify.

## Verification a person has to do

Nothing here can be done from a terminal. Carried forward until someone runs
the app:

- [ ] `backup_hook` set to `exit 1`; the Backup card shows the failure and the code
- [ ] the backup folder renamed while the app runs; Settings names the folder
- [ ] a temporary `throw` in Dashboard; the sidebar survives and "back to Billing" works
- [ ] the clock at 01:59; a backup is written two minutes later
- [ ] the app still pairs over Wi-Fi with two real machines
- [ ] Layer 3's four checks, before any build goes to a shop

From Phase 1, which is otherwise code complete. Audited on 16 September: the
other three on this list became tests, and the audit is in the Phase 1 section
above.

- [ ] the A4 print of a real bill read against Rule 46's list, on paper
- [ ] on a real LAN with the joiner idle, the host never says "Both tills agree"
      before contacting it (the logic is a tested pure function now; the LAN
      half is still a LAN)

And one gap the audit turned up, which is code rather than a check:

- [ ] a test that the GST tab is hidden under composition — `chargesTax()` is
      tested, `Reports.tsx` reading it is not

From Phase 3, which is code complete. These are the four that a terminal
genuinely cannot do — each needs a machine broken in a particular way:

- [ ] overwrite `shop.db` with random bytes; the window opens on `CouldNotStart`
      with the reason, and `logs/shopos.log` has the same line
- [ ] lock `shop.db` from another process; `kind: 'locked'`, message names the file
- [ ] break the rclone token; the next backup shows the card red with the output
- [ ] power cut on a VM during a burst of 50 bills; every bill whose submit
      returned is present (Layer 3's procedure)

Three more the spec wrote as manual checks are now tests and are not repeated
here: the diagnostics bundle's contents, the query plans, and the 500-change
merge. Two are covered by tests that already exist — a flipped byte inside a
backup zip (`archive.rs`), and a restore that is billed against end to end
(`restore.rs`) — though the second is still worth doing once in a Windows
Sandbox, because what that proves is the installer and the file paths, not the
code.

## Not committed

`docs/specs.zip` — a redundant archive of `docs/specs/`. Left untracked
deliberately; delete it or ignore it.
