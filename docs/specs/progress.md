# Progress

Branch `phase-0-and-the-test-bench`, 38 commits ahead of `main`, pushed to
`origin/phase-0-and-the-test-bench`. Not merged to `main`, and nothing is
released: no installer, no tag, no update anybody's till will fetch.

`tools/fixtures/` is gitignored as a folder and no `.db` is tracked. **The
fixture in it is dummy data** -- the owner confirmed on 16 September 2026 that
it can be erased or reshaped freely. See the note under "What the fixture
changed"; it is not the constraint earlier rows of this file treated it as.

State of the tree: **1,294 TypeScript tests** passing and 3 skipped (Phase 2c
placeholders that fail loudly if un-skipped early) across 93 files, **92 Rust
tests** passing with zero warnings, typecheck clean across core, app and bench,
and Layer 2 of the test bench green in Docker. Schema at 33.

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

### Row 7 — Phase 3 begins, a shop must not be able to lose data

Three commits, taken in the order that makes each one verifiable when it lands.

| Commit | What it stops |
|---|---|
| `481ecc0` | **The log file.** Rust and webview events in one file in one order, five files of a megabyte. `ErrorBoundary.tsx` had a `TODO(phase-3)` sitting on the `console.error` it replaces |
| `bc3be06` | **An icon that did nothing when double-clicked.** `setup()` ended in `Db::open(..)?`, so a database that would not open meant no window at all -- and `windows_subsystem = "windows"` means no console either. Plus `quick_check` at open, and advice per failure kind |
| `f0e6f93` | **A backup nobody had opened.** The archive is now read back and `integrity_check`ed before it is allowed to wear today's name, and there is a "Check" button per backup |

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

028 through 033, 1a, 1b, 1c and 1d are all done. 1,277 tests pass, 3 skipped,
91 files, typecheck clean.

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

**What is left of Phase 1 is verification a person has to do.** Five of its
eight checks need the owner's database with things staged by hand, because that
database cannot exercise the inter-state path on its own (finding 3): the shop
and every customer are `'33'`. Specifically, still to do by hand:

- [ ] shop state set to `27` on a copy; a bill to a `27` customer stores
      CGST+SGST and one to a `33` customer stores IGST, both read off
      `bill_items`
- [ ] amend a cancelled ₹900 bill; the draft is ₹900 with tax on ₹900
- [ ] the A4 print of a real bill read against Rule 46's list, on paper
- [ ] composition scheme on a copy: zero tax stored, *Bill of Supply* printed
      with the Rule 49 statement, GST tab hidden
- [ ] on a real LAN with the joiner idle, the host never says "Both tills
      agree" before contacting it — the logic is now a tested pure function
      (`syncNotice`), but the LAN half is still a LAN

Everything a terminal can check is checked.

### Phase 3 — a shop must not be able to lose data (in progress, ~3 days left)

Six of the spec's eleven file-level items are done (Row 7). What is left:

1. **`diagnostics_bundle()`** — a zip of the logs, `app_version`, the schema
   version, `device.json` **with `backup_hook` redacted** (it can hold an rclone
   token), `PRAGMA journal_mode/synchronous/page_count/freelist_count`, and the
   last 200 audit rows. Button on Settings → Support. This is where
   `log_paths()` comes back: it was written with the log and deleted again in
   the same commit for having no caller.
2. **`recomputeStock(db, productIds?)`** — replays only the products given.
   `sync.ts:328` passes the ids in the batch; the Dashboard stops calling it on
   mount and reads `product_stock` instead. The unbounded replay is also what
   fixes drift, so a weekly full replay stays on the 02:00 timer.
3. **Migration 034, additive** — indexes on `audit_log(actor_id)`,
   `bills(kind, docstatus, posting_date)` and
   `stock_ledger(product_id, posting_date, created_at)`. The spec calls it 029;
   that number went to `029_document_says_what_it_is` during Phase 1b.
4. **`totalOutstandingAll(db)`** — one `SUM` over the open-bill query, so the
   Credit page's "Total outstanding" stops being the total of the 500 rows it
   happens to display.
5. **`budgetMs` on `sql_tx_begin`** — the watchdog reads the budget off
   `ActiveTx`, so a legitimate 90-second merge is never rolled back under the
   JavaScript while a stuck bill is still cleared in 15. `sql_execute` refused
   while a transaction is open; `sql_query` still allowed, so the screen keeps
   working during a long merge.
6. **The log's remaining callers.** The spec asks for migrations, the backup
   outcome and every sync refusal to go through `log_event`, and commit
   `481ecc0` wired only `setup()`, the restore result, panics, `window.onerror`,
   `unhandledrejection` and the error boundary. The three named above are not
   yet logged — which matters most for sync refusals, since a schema mismatch
   between two tills currently leaves nothing on disk to read afterwards.
7. **A synthetic 20,000-bill shop.** Items 2, 3 and 5 all have verification
   steps that need one (`EXPLAIN QUERY PLAN` showing no full scan on a Dashboard
   mount; a 500-change merge completing without the watchdog firing; 600
   customers for the outstanding total). Nobody previously felt free to
   fabricate it. The fixture being dummy data unblocks this, and it belongs in
   the bench as a generator rather than a checked-in file.

### Phase 2 — foundations (~8 days)

Must not start until 1a–1c are merged, or Drizzle rewrites a query the GST fix
is changing. 2a by risk, then 2c's migration classification — which un-skips
`schema-skew.test.ts` in the same commit — then 2b's libSQL driver.

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

From Phase 1, which is otherwise code complete:

- [ ] the A4 print of a real bill read against Rule 46's list, on paper
- [ ] on a real LAN with the joiner idle, the host never says "Both tills agree"
      before contacting it (the logic is a tested pure function now; the LAN
      half is still a LAN)

From Phase 3, as each lands:

- [ ] overwrite `shop.db` with random bytes; the window opens on `CouldNotStart`
      with the reason, and `logs/shopos.log` has the same line
- [ ] lock `shop.db` from another process; `kind: 'locked'`, message names the file
- [ ] flip one byte inside a backup zip; "Check" says so
- [ ] break the rclone token; the next backup shows the card red with the output
- [ ] the diagnostics bundle opened by hand: no token in `device.json`, log
      present, version present
- [ ] restore into a Windows Sandbox and raise a bill from the restored data
- [ ] power cut on a VM during a burst of 50 bills; every bill whose submit
      returned is present

## Not committed

`docs/specs.zip` — a redundant archive of `docs/specs/`. Left untracked
deliberately; delete it or ignore it.
