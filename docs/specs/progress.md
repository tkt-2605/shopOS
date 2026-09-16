# Progress

Branch `phase-0-and-the-test-bench`, 34 commits ahead of `main`, pushed to
`origin/phase-0-and-the-test-bench`. Not merged to `main`, and nothing is
released: no installer, no tag, no update anybody's till will fetch.

The owner's own database is **not** in the repository and never has been --
`tools/fixtures/` is gitignored as a folder. The figures quoted in
`findings-real-shop.md` and `evidence/returns-in-gst-real-shop.txt` are the
aggregates this work was checked against, and they are in the shop's own repo.

State of the tree: **1,277 TypeScript tests** passing and 3 skipped (Phase 2c
placeholders that fail loudly if un-skipped early) across 91 files, **73 Rust
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

### Pulled forward out of order

- **Phase 1d's host-sync fix.** The bench demanded it: `host-initiates.test.ts`
  fails against the tree without it, and `npm test` may not stay red. Failing
  output kept at `evidence/host-initiates-before-1d.txt`.
- **The CGST/SGST fix**, applied on the owner's instruction ahead of Phase 1a.

---

## What the real database changed

`findings-real-shop.md` has thirteen findings now. Four affect the plan:

1. **CGST ≠ SGST on 29 of 51 lines.** Not in any spec. Fixed.
2. **The shop charges GST with no GSTIN set.** ~~Phase 1's scheme rule will
   default it to `unregistered` and stop charging tax.~~ **Settled** — finding
   11. The premise was wrong: there was no screen that could save a GSTIN until
   `services/shop.ts`, so the empty field says nothing. The till reads what the
   shop has been *doing* instead and goes on charging exactly as before. Still
   an owner decision, no longer an urgent one.
3. **This database cannot exercise the inter-state path.** Every customer is
   `'33'` — the fabrication the plan predicted — and the shop is also `'33'`,
   so the fabrication and the truth coincide and `SUM(igst_amount)` is zero.
   Phase 1's IGST verification has to be staged by hand.
4. **The dashboard's tax figure and the GST rate rows now differ** by the tax
   on a credit note -- gross against net. Both honest, different questions, two
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

### Phase 3 — a shop must not be able to lose data (~5 days)

Runs alongside Phase 1; different files. Startup failure that reaches a screen,
backups proved after they are written, the log file, the diagnostics bundle,
the transaction budget. The log file is wanted before the first outside
install.

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
| 4 | Whether TRT is GST-registered | Phase 1's scheme default | a decision |

Row 4 is new, from the real database, and is the only one that affects the next
phase.

## Verification a person has to do

Nothing here can be done from a terminal. Carried forward until someone runs
the app:

- [ ] `backup_hook` set to `exit 1`; the Backup card shows the failure and the code
- [ ] the backup folder renamed while the app runs; Settings names the folder
- [ ] a temporary `throw` in Dashboard; the sidebar survives and "back to Billing" works
- [ ] the clock at 01:59; a backup is written two minutes later
- [ ] the app still pairs over Wi-Fi with two real machines
- [ ] Layer 3's four checks, before any build goes to a shop

## Not committed

`docs/specs.zip` — a redundant archive of `docs/specs/`. Left untracked
deliberately; delete it or ignore it.
