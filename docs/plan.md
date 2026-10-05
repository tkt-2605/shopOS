# ShopOS — from working software to a product other people's shops run on

## Context

ShopOS works. 1047 tests, 65 Rust tests, schema 27, and a multi-device seam that
was verified this week on real hardware: two tills pairing over the shop's wifi
with a typed code and carrying 189 records — a real shop's 20 products, 6
customers, 29 bills — in one round.

None of that is the same thing as a product a stranger's shop can depend on.
Three audits run against the current tree found what the gap actually is:

| Where | What |
|---|---|
| **Tax** | Seven live defects. The worst charges the wrong head of tax on every bill for any shop outside Tamil Nadu |
| **Survival** | A corrupt database shows the shopkeeper *nothing at all*. Offsite backup can fail forever in silence. A power cut loses the last bills of a session |
| **Delivery** | No signing, no CI, no updater, no log file, no version string. A fix means visiting the shop |
| **Unwired** | The host till's sync loop is wired to a column nothing fills, so it contacts nobody and reports success. Cash-drawer counts are written and unreadable. Nothing can be retired or deleted |

The decision that shapes everything below: **the installed base is zero.** This
is the cheapest moment this product will ever have to make expensive changes, and
the owner has chosen to spend it — Drizzle and libSQL now, correctness first,
one sequence done properly rather than a rush to a first shop.

Three licence tiers are the commercial shape: **single device**, **cloud**, and
**branches**.

---

## Rules this plan does not get to break

Existing rules in `CLAUDE.md` stand. Four more, earned this week:

1. **Billing never stops.** Not for a lapsed licence, not for a failed sync, not
   for a cloud that cannot be reached, not for an expired certificate. A till
   that cannot sell is worse than any problem it is protecting the shop from.
2. **Nothing is "on" unless it is visible.** This codebase's recurring fault is a
   switch that is on and does nothing — `shop_state_code`, `device_register_id`,
   `origin_id`, `product_stock` after a merge, `deviceProblem()`. Every item
   below ends with a person being able to *see* the thing work, not with the code
   existing.
3. **Verify against the owner's real database**, not only the test fixture. Every
   bug that mattered this week was found that way, and two were found *by* the
   fixture lying.
4. **A submitted document is never rewritten.** Legal, and the schema's oldest
   rule.
5. **A test that exercises one side has tested one side.** The host-till sync bug
   in 1d survived 1047 tests, a suite of real-socket HTTP tests, and a live run
   against the owner's own shop — because in every one of them the *joining* till
   initiated. Symmetry is not implied; it has to be asserted from both ends.

---

## Architect pass — the open calls, decided

The brief in `docs/prompts/fable-shopos-architect-prompt.md` asks for the layer above this
plan: every open judgment resolved with reasoning and a confidence, and one
execution-ready spec per phase. The decisions are here because three of them
overturn something the plan states as settled. The specs are written on
approval (see *What gets written*, at the end of this section).

### 1. libSQL spike — **do not swap the local engine.** Confidence: high

Checked against Turso's own documentation rather than run: Turso now says *"if
you're starting a new project, we recommend Turso Database"* (the Rust rewrite,
still beta) and positions libSQL as the battle-tested fork for workloads that
need it *today*. That is a vendor telling you where its investment has gone.
A POS's local file is the last place to sit on either a beta engine or a fork in
its long tail. Also material: the `libsql` crate is async over tokio, lacks
`prepare_cached`/`column_decltype` that `db.rs` uses, and every backup and
restore path (`VACUUM INTO`, `restore.rs`, `archive.rs`) is written against
rusqlite and proven on the owner's machine.

So: **`rusqlite` stays.** Turso is used exactly as Phase 6 already intends,
hosted per-shop storage reached over the client protocol, and the *only* code
that talks to it is the headless till running under Node with `@libsql/client`
wrapped as a `SqlDriver` (the interface is 19 lines). The Phase 2b spike moves to
the start of Phase 6 and shrinks to: run the migration list and the feed
triggers against a local `turso dev` instance and confirm `PRAGMA
defer_foreign_keys`, `AUTOINCREMENT` and trigger semantics. The `SqlDriver`
seam also keeps the fallback honest: the same headless till writes to a plain
SQLite file on a VPS if Turso ever stops being the right host.

### 2. Drizzle rollout order — **by risk, not by file.** Confidence: high

The plan's service-by-service order is the wrong unit. All five hand-written
column bugs this week were in money paths. Order: the parity test first (it is
the safety net for everything after), then `billing.ts`, `returns.ts`,
`payments.ts`, `cash.ts`, `repos/reports.ts`, then stock, then everything else.
Two rules the spec carries: **never call Drizzle's own `transaction()`**, which
the proxy driver implements by sending bare `BEGIN`/`COMMIT` through the
callback and so bypasses the token that `db.rs` watches with its watchdog;
instead a Drizzle instance is built over whichever `SqlDriver` the caller holds,
`db` or `tx`, so the existing transaction discipline is untouched. And the
schema file is seeded by `drizzle-kit pull` against the owner's migrated
database, then hand-typed for `Money`/`Qty` brands, never written from memory.

### 3. Licensing — **30 days' grace, offline-verified, and lapse hides nothing local.** Confidence: medium

- **Token**: Ed25519-signed JSON `{shop_id, tier, paid_through | null,
  tills, issued_at, kid}`, public key compiled into the binary, stored in
  `settings` so it replicates to every till with the shop's other settings.
  Single-device is perpetual (`paid_through: null`); cloud and branches are
  subscriptions.
- **States**: *active* until `paid_through`; *grace* for 30 days after, with a
  renewal banner; *lapsed* after that. 30 days because Indian small shops pay
  monthly or yearly by UPI, close for festivals, and a week is not long enough
  for a missed payment to be an honest mistake, while a month bounds the
  vendor's exposure to one billing cycle.
- **Re-check**: on start and every 24 h when online, the till asks the portal
  for a fresh token; the portal records the device ids it hears from, which is
  how the till count is observed. Offline, the cached token is trusted to its
  dates. Clock going backwards more than a day against the high-water mark kept
  in `device.json` means *clock unreliable*: keep the current state, say so,
  never lapse on that alone.
- **Lapse means**: cloud relay, cloud backup and the phone view stop, with a
  message and a date. **LAN sync between paired tills keeps working**, the
  editor for nothing local is hidden, billing never stops, and nobody is
  un-paired. Cloud features are the enforcement point because they are the ones
  the vendor operates; refusing to sell or to sync two tills in a shop would
  break rule 1 to protect a subscription.
- **Piracy**: a token is bound to `shop_id`. Copying one to a second shop needs
  a copied database, which brings the first shop's books with it. Accepted
  risk; not worth a stronger scheme at this scale.

### 4. Turso and rclone — **independent, by design. Both stay for a cloud shop.** Confidence: high

The rclone hook is the shop's own copy on storage the shop controls, and it
survives the vendor. A cloud replica is not a backup: it faithfully replicates a
bad delete. So every tier keeps the Phase 0 backup; the cloud tier *adds* the
per-shop database and daily snapshots of it. On downgrade the replica is frozen
read-only for 90 days and then deleted, with an email at both points; the local
and rclone backups are untouched, and Settings shows each copy's last-success
date and which are yours. Nothing is dropped silently.

### 5. Layer 2 on hosted CI — **expected to work; proven by a smoke job, with the fallback pre-decided.** Confidence: medium

Linux bridges forward limited broadcast between containers on the same
user-defined network, and hosted `ubuntu-latest` runs Docker with exactly that.
One compose network per scenario gives separate broadcast domains, which is what
`discovery.rs` needs. Two things the plan did not say: discovery is **Rust**, so
the container needs it as a small binary, which means extracting `discovery.rs`
and `sync_server.rs` into a workspace crate `crates/shopos-net` with a `bin`
the container runs beside the Node till. And Layer 2 is a `workflow_dispatch`
plus nightly job, **never a required check**; Layer 1 is the required one. The
first Layer 2 job is a two-container broadcast smoke test; if it fails on hosted
runners, Layer 2 becomes self-hosted-only and the workflow says so.

### 6. Code signing — **an OV certificate to the proprietor, key on a cloud HSM. This is a paperwork dependency, not code.** Confidence: high

Azure Artifact Signing is not available: its Public Trust is limited to
organisations in the US, Canada, EU, UK, AU, NZ, JP, KR, SG, CH, NO and IL, and
individuals to the US and Canada. EV requires a registered legal entity and
gives no SmartScreen shortcut any more. So: an OV code-signing certificate from
a CA that sells to Indian individuals or firms (SSL.com, Certum, DigiCert),
issued to the proprietor or to the firm if it has Udyam/GST registration, with
the key held in the CA's cloud signing service so CI can sign without a USB
token. Tauri's `bundle.windows.signCommand` calls the CA's CLI. SmartScreen
will warn until reputation accrues over weeks of clean installs; the installer
walkthrough has to say so. The Tauri **updater** key (Ed25519, `pubkey` in
`tauri.conf.json`) is a separate thing and is generated on day one: every
build from the first release must be verifiable by every later updater.

### 7. Phone view auth — **one identity, the shop account. No second auth system.** Confidence: high

The licence has to be issued to *someone*; that someone is the shop account on
the vendor portal (owner email, password, later phone OTP). The same account
owns the licence, sees the phone view, and receives the downgrade emails. The
portal is therefore a real scope item the plan hid in one bullet: a small
service (`apps/portal`) that mints licence tokens, creates per-shop Turso
databases, serves the phone view API from them, and receives diagnostics. One
codebase, one login.

### 8. Tamil — **Noto Sans Tamil under the OFL is fine to bundle; the real gap is shaping.** Confidence: high

The OFL permits embedding and bundling with the licence text included. What the
plan understates: Tamil needs OpenType shaping (vowel signs reorder to the left
of the consonant, ligatures form) and `pdf.rs` draws glyphs by code point. A
dependency-free path renders it wrong. Use `rustybuzz` + `ttf-parser` (pure
Rust) for the PDF, and render the thermal receipt's Tamil lines as a raster
because most ESC/POS printers have no Tamil code page.

### 9. WhatsApp — **`wa.me` share in Phase 5; the Cloud API is a cloud-tier feature with a lead time.** Confidence: high

The Cloud API needs Meta business verification (GST or Udyam certificate, 2–4
business days), a phone number not on consumer WhatsApp, template approval, and
per-message pricing (India utility ≈ ₹0.13–0.15, with 24-hour-window messages
becoming paid from October 2026). None of that is code. Phase 5 ships the
zero-approval path: a "Send on WhatsApp" that opens `wa.me/<phone>?text=` with
the bill summary and saves the PDF for attaching. The API version is Phase 6,
gated to the cloud tier, and starts its paperwork when Phase 6 starts.

### Also found to be guesses

- **The invoice is not snapshotted.** `bills` has no `customer_gstin`,
  `customer_address`, `customer_state_code` or `supply_type`; the GST report
  and every re-print join *live* `customers`, so editing a GSTIN rewrites every
  past invoice, and `returns.ts:131` re-derives the supply type from the
  *current* shop state. Migration 028 adds the four snapshot columns. This is
  the "never rewritten" rule applied to what the paper said.
- **Every shop is assumed GST-registered under the regular scheme.** A
  composition dealer may not charge tax and must print *"composition taxable
  person, not eligible to collect tax on supplies"*; an unregistered shop
  issues a bill of supply, not a tax invoice. Add `shop_tax_scheme`
  (`regular | composition | unregistered`) with the title, the tax columns and
  the GST reports following it. A large share of the product's market is not
  `regular`.
- **Rule 46(f)**: an unregistered recipient on a bill of ₹50,000 or more must be
  named with address and state. Submit refuses with `NEEDS_RECIPIENT`, the
  screen opens the customer form. A required field, not a stopped till.
- **Section 34(2)**: a credit note against a bill from a previous fiscal year
  cannot reduce tax after 30 November. Warn on the return, never block.
- **HSN** is free text. Validate 4/6/8 digits when present; warn, never block;
  the GST export lists lines missing it, because Table 12 B2B is mandatory.
- **`integrity_check` at startup** (Phase 3) on a large file takes seconds on a
  shop PC. `quick_check` at start; full check weekly and inside every backup.
- **`installMode: currentUser`** stays. Shop PCs run one account; `perMachine`
  would make every auto-update a UAC prompt. The `CouldNotStart` screen says
  when a database exists under another Windows user.
- **"Daily backup actually daily"**: `backup.ts:139` says once-per-opening is
  by design. The fix is a 02:00 timer *and* on-open, not a replacement.

### What gets written on approval

`docs/specs/`: `phase-0-spec.md` … `phase-7-spec.md`, `test-bench-spec.md`,
`execution-order.md`, in the brief's format (scope, decisions, file-level tasks
with `[delegate: …]` marks, dependencies, checklist verification). Phase 2b
becomes the `@libsql/client` `SqlDriver` and the Phase 6 spike; Phase 1 gains
migration 028 and the tax scheme; Phase 4 gains the portal and the OV paperwork
as a dated external dependency; Phase 5's WhatsApp is the share path.

---

## Phase 0 — Stop the bleeding

Half a day. Each item is small and removes a way a shop loses money or data.
Do these before anything else, in one commit each.

| Fix | File | Why |
|---|---|---|
| `PRAGMA synchronous = FULL` | `src-tauri/src/db.rs:92` | Under WAL, `NORMAL` is not durable across a power cut. Indian mains, no UPS: the last bills of a session vanish after the goods left the shop. One word. Costs one fsync per commit — unnoticeable at a bill every 30 seconds |
| Surface backup failure | `apps/pos/src/core/backup.ts:126,144` | `runHook(...).catch(() => undefined)` discards both a throw **and** a non-zero exit. A shop whose rclone token expired has had no offsite backup for months and nothing ever said so. `runDailyBackup`'s `error` is also dropped at `CoreProvider.tsx:214` |
| Stop `listBackups` lying | `backup.ts:20-34` | Catches and returns `[]`, so a failed query shows "no backups" to a shop that has a folder full |
| React error boundary | around `PageBody`, `App.tsx:305` | A throw anywhere blanks the entire window — no sidebar, no text, no way back but killing the process |
| Version string on Settings | new; `app.package_info()` | You cannot ask a shopkeeper what build they are on, and they cannot tell you. Today the only way to find out is to read `manifest.json` out of a backup zip |
| Daily backup actually daily | `CoreProvider.tsx:214` | Runs once at mount. A till left on all week takes **one** backup |
| `noUnusedLocals` + `noUnusedParameters` | `tsconfig.base.json` | Off today, and there is no eslint config, so nothing catches dead code. Turning both on makes a whole class self-policing and currently surfaces 7 real unused symbols |

---

## The test bench — because there is only one machine

Everything below Phase 1 needs two or more tills, and there is one PC. Worse, the
host-sync bug in 1d is exactly the kind that hides when a suite can only imagine
a second machine. This is built first, because nothing after it can be trusted
without it.

### Layer 1 — the headless till (no Docker, runs in CI)

`tools/virtual-till` — a Node process that is `packages/core` plus the HTTP sync
handler and nothing else. No UI, no Tauri. It already exists twice in draft form:
`serve()` in `syncOverHttp.test.ts`, and the throwaway used to pull the owner's
real shop into a second database this week. Make it a real thing:

- its own data directory and SQLite file (the volume isolation, achieved with a
  temp dir rather than a container)
- its own device identity — `setDeviceId` is process-global, which is a nuisance
  in one process and exactly right when each till *is* a process
- its own port, and an injectable clock so **skew between tills is a parameter**,
  not an accident — the merge rule's timestamp tiebreak has never been tested
  against two disagreeing clocks
- an injectable transport so a partition, a delay, or a reply lost *after* the
  far side committed can be produced on demand

This is not throwaway. **A headless till is what the Phase 6 cloud peer is** — a
process running core with no screen — so this is the first commit of the cloud
tier, arriving early and paying for itself twice.

### Layer 2 — containers, for the parts that need a real network

Docker Compose, one network per scenario, a volume per till. Worth it only for
what loopback cannot fake:

- **UDP discovery.** `discovery.rs` broadcasts to `255.255.255.255` and the
  subnet. On one host this is awkward — proving it this week meant stopping the
  app to free port 7802. Separate network namespaces give each till a real
  broadcast domain.
- **Addressing.** `lan_address()` picks the interface traffic leaves by; on the
  owner's machine that meant choosing between a Wi-Fi address and a WSL adapter.
- Partitions and packet loss, via the network rather than a stubbed transport.

Note the boundary: the container runs the **headless till**, not ShopOS. The
protocol is identical — `handleSyncRequest` is the same function the app calls
from Rust — so this tests the thing that matters and skips the thing that cannot
be containerised.

### Layer 3 — what no container reaches, and how to cover it

Honest about the gap rather than pretending the bench closes it:

| Cannot be containerised | Cover it by |
|---|---|
| Tauri ↔ webview bridge, printing, `device.json` beside the database | The one Windows machine, as this week |
| The installer, signing, SmartScreen, the updater applying | **Windows Sandbox** (built into Win 10/11 Pro — a disposable clean Windows) or a Hyper-V VM. Rare and manual, and the only honest test of "a PC that has never seen this app" |
| Power-cut durability (`synchronous = FULL`) | A VM whose power you can cut, or physically pulling the plug on the one machine |
| Two tills on genuinely separate hardware | Deferred, and named as deferred. The bench makes it unlikely to be the first thing that finds a bug, not impossible |

### What the bench must prove

| Scenario | Catches |
|---|---|
| **The host initiates** | The 1d bug. Never exercised by any existing test |
| Either till offline, then back | Backoff, catch-up, and the host being unable to initiate |
| Both edit one row, clocks disagreeing by minutes | The timestamp tiebreak, which no test has ever driven |
| Reply lost after the far side committed | `/offer` idempotency under a real failure rather than a rewound cursor |
| v(N) against v(N−1) | The additive/breaking rule from 2c |
| A third till joins a shop mid-trade | `seedFeedWithEverything` against a shop with real volume |
| Two tills, one counter | The `SAME_REGISTER` refusal |

---

## Phase 1 — The bills have to be right

Nothing else matters if the paper is wrong, and shipping auto-update to shops
raising bad invoices only distributes the problem faster.

### 1a. Wrong numbers

- **The hard-coded state code.** `services/customers.ts:152` writes
  `state_code` as a literal `'33'`; `updateCustomer` omits the column entirely so
  it can never be corrected; `pages/Customers.tsx` has no state field at all.
  For a shop outside Tamil Nadu every named-customer sale resolves inter-state
  and charges **IGST where CGST/SGST is due**, and the bogus value propagates
  into `bills.place_of_supply` and out through `reports.ts:273` into the CA's
  working file.
  - Add a state field to the customer form; derive it from the GSTIN when one is
    given, the way `shop.ts:190` already does for the shop; default to the shop's
    own state.
  - Migration: `UPDATE customers SET state_code = NULL` — every existing value is
    fabricated, none was ever entered by a person. `supplyTypeFor(shop, null)`
    returns `intra_state` (`tax.ts:65`), which is right for counter retail and
    matches today's behaviour for a TN shop.
- **`amendBill` drops every discount.** `billing.ts:690` selects `discount` and
  never passes it; the bill-level discount, notes and posting date are lost too.
  A cancelled ₹900 bill amends into a ₹1,000 draft with the tax overstated.
- **Returns are invisible to the GST reports.** `reports.ts:203` and `:264` read
  `bill_items` only; `sales_return_items` carries its own taxable and tax columns
  and is never touched. A shop filing from this export **pays tax on goods it
  took back**.
- **Float division in a money path.** `receipt.ts:421` computes `units =
  lineTotal / rate`, but `lineTotal` is net of discount, so the printed "Save ₹X"
  is wrong on any discounted line and is `Infinity`/`NaN` when rate is 0. `qty`
  is on the same object.
- **`gstLines.total` excludes `round_off`** (`reports.ts:299`), so the export
  will not tie to `bills.grand_total` on any rounded bill.

### 1b. What the paper must carry

Rule 46 requires these and the renderers are already waiting for them — they
simply always receive `undefined`.

- **Per-line tax rate and the CGST/SGST/IGST split.** `ReceiptItem`
  (`receipt.ts:65`) has no `taxRateBp`; `invoiceHtml.ts:222` collapses the three
  heads into one "Tax" column; the rate-wise summary block prints a single row of
  bill totals. `bill_items` stores all of it. This is the largest single gap.
- **Recipient GSTIN and address.** `printHtml.ts:129` never sets them and
  `loadBillDetail` (`catalog.ts:364`) never joins `customers`.
- **Place of supply is the shop's own state** (`printHtml.ts:159`), not the
  bill's — so an IGST invoice prints a place of supply that contradicts the tax
  charged.
- **Credit note has no print path at all.** The record is correct — its own
  `C` series, an FK to the original bill — but nothing renders it, and Rule 53
  requires it to be *issued* to the customer.
- **"Reverse charge: No"** appears nowhere in the codebase and is mandatory on
  every tax invoice.

### 1c. Guards, so these cannot come back

- Refuse to submit a bill when `shop_state_code` is unset, rather than silently
  treating everything as intra-state (`tax.ts:65`, acknowledged in `shop.ts:9`).
- Validate customer GSTIN with the same `GSTIN_SHAPE` the shop already uses.
- A test that asserts a rendered A4 invoice contains every Rule 46 field.

### 1d. Switches that are on and do nothing

The sweep found these. Each is the house fault, and the first is in code written
and declared working this week — every test and the live run had the *joining*
till initiate, so nothing ever exercised the host's own loop.

- **The host till never syncs outbound.** `pairedPeers()` filters `WHERE address
  IS NOT NULL` (`syncClient.ts:147`), but only the joiner writes `address`
  (`:129`); the host inserts without it (`syncServer.ts:147`) and `rememberPeer`
  writes less still (`sync.ts:558`). So on the host `pairedPeers()` returns `[]`,
  `syncLoop.ts:101` never enters its loop, and `SyncCard.tsx:140` reports **"Both
  tills agree."** having contacted nobody. `rememberAddress()` (`syncClient.ts:157`)
  exists to fix exactly this and is called by nothing.
  *Fix:* record the peer's address at pairing and on every inbound request; make
  the empty-peer case say "nothing to sync with" rather than "both tills agree";
  add a test where the **host** initiates.
- **`amendBill` has no caller in the app.** `billing.ts:683` is reachable only
  from tests, so the documented "correction is cancel + amend" model has no amend
  half, and `bills.amended_from` is never non-null in production. Fixing its
  discount bug (1a) is necessary but not sufficient — it needs a button on
  `Bills.tsx`. `sales_returns/payment_entries/stock_entries.amended_from` are
  never written by anything at all.
- **Nothing can be retired or deleted.** `products.is_active` is read by four
  queries and set by none — an item can never be taken off the list. `deleted_at`
  is filtered on in `products`, `customers`, `roles`, `users`, `price_lists`,
  `suppliers` and written in none of them; `deleteSupplier` hard-deletes,
  contradicting its own comment. Decide per table: wire the soft delete or drop
  the column.
- **The cash drawer's count is written and unreadable.** `cash_sessions`
  `closed_by`, `expected_cash`, `actual_cash`, `variance`, `notes` are all
  written at `cash.ts:148` and **never SELECTed anywhere**. There is no
  cash-close history screen, so yesterday's till shortage is gone the moment the
  modal closes. This is a real product gap wearing the costume of dead columns.
- **`activity_log` has zero readers *and* zero writers.** `writeActivity`
  (`audit.ts:61`) is called by nothing. Either wire it or delete both.
- **`changePassword` is orphaned** (`auth.ts:194`) — a user can never change
  their own password; only an admin reset exists. Same for `renameCategory` and
  `removeCategory` (`grouping.ts:84,135`): categories can be created and never
  renamed or removed.
- **`SchemaTooNewError` / `SchemaUnversionedError`** are exported and never
  `instanceof`-checked, so "this database was made by a newer ShopOS" reaches the
  user as a generic startup failure string.
- Smaller: `documents.round_off` written but omitted from `loadDocument`, so a
  rounded quotation prints lines that do not add up; `sales_returns.tax_reversed`
  written and never read; `schema_bootstrapped_at` written and never read;
  `ACCEPTED_MIME` is the documented allow-list and is never consulted — the real
  check is a hand-copied string literal in `Attachments.tsx:140`.
- Genuinely dead, delete: `filePresent`, `thisDevice`, `modalDepth`,
  `onModalStackChange`, `openDatabase`, `isSubmitted`, `isCancelled`, `neg`,
  `isZero`, `cmp`, `cmpQty`, `isPositive`, `toBaseUnits`, `ZERO_REFUND`,
  `describeShort`, and the unreachable `App.tsx:342` fallback.
- `sync_queue` remains zero-readers, zero-writers. Drop it — the shape was a
  guess made on day one and Phase 6 will not use it.

**Clean, and worth recording so it is not re-audited:** every feature flag in
`services/features.ts` gates something real; every UI component is mounted; there
are no no-op handlers, no empty `catch {}`, and not one `TODO`/`FIXME` in the
entire codebase.

---

## Phase 2 — Foundations, while the installed base is zero

### 2a. Drizzle, for queries only

416 SQL call sites across 45 files, none larger than 40 — so this goes in
**service by service**, each its own commit with the existing tests as the net.

Five mistakes in a single day's work this week were hand-written column names
drifting from the schema: `saveCustomer`, `discount_total`, `fx.seed.userId`,
`bill_items.sale_unit`, `price_source`. Typed queries kill that class dead.

- `drizzle-orm/sqlite-proxy` wraps the existing `SqlDriver` — the interface is
  30 lines and already async-callback shaped, so both the node and Tauri drivers
  work unchanged.
- **Migrations stay hand-written.** `drizzle-kit` diffing the schema would fight
  108 feed triggers, the `rev` triggers, `defer_foreign_keys` and the replica
  shape — all load-bearing and none expressible in Drizzle's DSL.
- The risk this creates is the schema file drifting from the migrations. Kill it
  the way this codebase already kills that class: **a parity test that
  introspects the real database and asserts the Drizzle schema matches**, exactly
  as `replicaShape.test.ts` does for the replica shape.

### 2b. A `SqlDriver` for Turso, so the cloud tier is reachable later

Decided in the architect pass (§1): **the local engine stays `rusqlite`.**
What remains of 2b is small and lives in core, not Rust:

- `packages/core/src/db/libsql-driver.ts`: `@libsql/client` behind the same
  19-line `SqlDriver` interface, `BEGIN IMMEDIATE` mapped to a write
  transaction, used only by the headless till when it runs as the cloud peer.
- The spike moves to the start of Phase 6 and runs against a local `turso dev`:
  the full migration list, the feed triggers, `PRAGMA defer_foreign_keys`, and
  a two-till sync through it. `VACUUM INTO` is no longer a question, because
  nothing local changes.

### 2c. Migrations that can be rolled out

This is what makes shipping a feature easy later, and it is the piece with no
code today.

- Classify every migration **additive** or **breaking** in the list at
  `db/migrations.ts`. Adding `customer_groups` and a nullable column is additive;
  renaming a column or tightening a CHECK is breaking.
- `syncWith` currently refuses across *any* schema difference. Relax it to allow
  an N−1 peer when everything between the two versions is additive — otherwise a
  staged rollout halts the shop's sync, which is the single thing that would make
  every future release painful.
- A test that replays every migration against a copy of a real shop's database
  and asserts `integrity_check`, zero FK violations, and row counts preserved.

---

## Phase 3 — A shop must not be able to lose data

- **A corrupt database must reach the recovery screen.** Today `Db::open` fails
  inside `setup()`, the `?` propagates, and `lib.rs:85` is `.expect(...)` in a
  `windows_subsystem = "windows"` build: panic to a detached stderr, **no window,
  no message, nothing**. The `CouldNotStart` screen and its `RestorePanel` —
  built for exactly this — can never render, because the webview never loads.
  Carry the failure into app state and let the webview show it.
- **`PRAGMA integrity_check` at startup**, so a database that opens but is
  damaged is not used as-is.
- **Verify the backup after writing it.** `archive.rs:68` computes its CRCs from
  the same buffer it just wrote — they prove nothing about what landed on disk.
  Re-open the finished zip and run `integrity_check` on the extracted database.
- **A "test this backup" button.** `restore_inspect` (`restore.rs:167`) already
  does the right checks and is only reachable *inside a destructive restore*.
  Nobody finds out their backups are sound without performing one.
- **An end-to-end restore test**: write a zip, stage it, `apply_pending`, then
  query the resulting database for the bills it should contain. The staging logic
  is well tested; the whole path is not.
- **A log file and a diagnostics bundle.** Today there are 5 `console.error`s and
  1 `eprintln!` in the entire product, and in a release build **both destinations
  are /dev/null**. Rolling log in the app data folder capturing Rust panics,
  `setup()` failure, migration results, the daily backup outcome and uncaught
  frontend errors; one button that zips it with the version and schema number.
  Local always; upload only for cloud-tier shops, with consent asked once —
  which is what this architecture already implies, since the webview cannot reach
  the network and all network code lives in Rust.
- **Scale, before it bites.** `recomputeStock` replays the *entire* ledger with
  no `WHERE` and no index serving its `ORDER BY`, and runs on **every Dashboard
  mount** and **every 45-second sync round that carried a ledger row**
  (`sync.ts:328`) — on one connection behind one mutex, blocking every other
  query. Bound it to the products in the batch. Then: indexes on
  `audit_log(actor_id)` and `bills(kind, docstatus, posting_date)`; the Credit
  page's `searchCustomers(db, '', 500)` computing "Total outstanding" from a
  capped list, which is a **silently wrong number on a money screen** for any
  shop with more than 500 customers.
- **Reconcile the two timeouts.** `TX_TIMEOUT` is 15s (`db.rs:16`) and the sync
  server allows 60s (`sync_server.rs:49`) for a batch of up to 500 changes. The
  watchdog can roll a legitimate merge back underneath the running JavaScript.
  Also: `sql_query`/`sql_execute` do not check `active_tx`, so a stray write can
  silently join an open transaction.

---

## Phase 4 — Getting it onto a shop's PC, and updating it

- **Code signing. Start the certificate today** — it has the longest lead time of
  anything in this plan. Architect pass §6: an OV certificate to the proprietor
  or firm, key in the CA's cloud signing service, and the Tauri updater key
  generated the same day. SmartScreen warns until reputation accrues either way.
- **CI** (`.github/workflows`, none today): the 1047 tests, typecheck, `cargo
  test`, both builds, and the migration-replay test from 2c. On every push.
- **The Tauri updater**: no `plugins.updater`, no `pubkey`, no
  `createUpdaterArtifacts` today. Versioning is three hand-maintained numbers in
  three files and `git tag` is empty — one source, driven by CI.
- **Licensing, three tiers.** Keep it a separate axis from `services/features.ts`
  — that is what the *shop* chose, this is what the shop *paid for*, and
  conflating them means a downgrade destroys a shop's settings. Entitlement gates
  the editor, never the data, exactly as the existing "nothing is deleted" rule
  does. Offline validation with a long grace period, and **a lapsed licence never
  stops billing** — it hides paid features and says why.
- Settle `installMode: currentUser` (`tauri.conf.json:46`): if a shop's till is a
  shared Windows account, a reinstall under a different user points at an empty
  database.

---

## Phase 5 — What a shop does every day

From the standing backlog, ordered by how often a shopkeeper hits the gap:

CSV catalogue import with a dry run · **cash-close history** (the data is already
written, see 1d — this is a screen, not a feature) · day book / Z report ·
**amend a bill** (the service exists and has no button) · **retire an item**
(`is_active`) · **change your own password** · purchases with supplier bill and
input GST · supplier payables · expenses · customer ageing buckets · per-item
stock movement · dead stock · **tier labels** (asked for four rounds running,
never built) · Tamil on receipt and PDF (needs an embedded font; `pdf.rs` carries
WinAnsi only) · WhatsApp the bill · open-price item · quick keys ·
weight-embedded barcodes.

Several of these are unusually cheap because Phase 1d already found the service
and the columns sitting there unused — the work is a screen, not a system.

Plus the GSTR-1 working file properly: HSN summary (Table 12), B2B/B2C split,
B2CS by place of supply, credit notes (CDNR), and the document-issued summary
(Table 13) — `doc_sequences` already holds what Table 13 needs.

**Customer buckets is the proof of Phase 2c**: a new table, a nullable column, a
service and a screen, rolled out to a shop with one till switched off, with sync
never halting. If that is not easy, 2c was not done.

---

## Phase 6 — The cloud tier

Built on what already exists: `docs/multi-device.md` says *"a device is a till
today and a server process tomorrow"*, and the sync protocol treats the cloud as
**one more peer**. Four things the owner wants, in the order they earn their keep:

1. **Off-site backup and remote support.** One Turso database per shop — which is
   exactly the database-per-shop decision already taken. Sells on fear, and is
   the smallest useful thing.
2. **Internet sync between tills**, relayed through the shop's cloud database
   using the protocol already built and tested.
3. **The owner's phone view** — read-only: today's takings, what sold, what is
   short. Served by the portal from the shop's own database, behind the shop
   account that already owns the licence (architect pass §7). This is usually
   what actually sells a cloud tier in retail.
4. Diagnostics upload for cloud-tier shops, from Phase 3.

Use Turso as **hosted per-shop storage with our own sync semantics**, not as a
sync engine — adopting libSQL's offline-write conflict model would throw away
merge rules now tested against two real databases.

---

## Phase 7 — Branches

The third tier, and a genuinely different product: per-branch stock, transfers
between branches, consolidated reporting, and a branch dimension on every report.
`docs/multi-device.md` defers this until the LAN case has run in a real shop for
a season, and that judgement stands. Planned here so the tier can be priced; not
started until Phase 6 has shops on it.

---

## Verification

Per phase, and none of it is "the tests pass":

- **Phase 0/1**: a bill raised in a shop whose state code is Maharashtra carries
  CGST/SGST to a local customer and IGST to an out-of-state one — asserted on the
  stored row, not the screen. An amended bill keeps its discount to the paisa. A
  rendered A4 invoice contains every Rule 46 field. `pull` the owner's real
  database and re-run the reports before and after.
- **Phase 1d**: on the bench, a scenario in which the **host** initiates — the
  case every existing test and the live run missed. Then switch the joiner off:
  the host must catch up when it returns, and must never say "both tills agree"
  when it has spoken to nobody.
- **Phase 2**: the Drizzle parity test passes against a migrated real database;
  the migration replay preserves row counts and `integrity_check`; a v(N) and a
  v(N−1) till sync when the difference is additive and refuse when it is not.
- **Phase 3**: rename `shop.db` to garbage and launch — the recovery screen
  appears. Break the rclone token and confirm Settings says so. Restore a backup
  into a fresh Windows Sandbox and bill from it. Power-cut durability needs a VM
  whose power can be cut, or the plug on the one machine.
- **Phase 4**: install the signed build in a clean Windows Sandbox — a machine
  that has genuinely never seen it — then ship an update to it and watch it
  apply. This is the one thing the bench cannot stand in for.
- **Phase 5/6**: add customer buckets and roll it across the bench to a shop
  whose second till is switched off, and confirm sync never halts.

---

## Deliberately not doing

Carried from the existing plan and still true: ERPNext's Promotional Scheme as a
code generator, blanket orders, serial numbers, Delivery Note and Purchase
Receipt as separate documents, Landed Cost Voucher, Item Alternative, territory,
sales partner, campaign, multi-warehouse, cost centres, a full chart of accounts,
ERPNext's POS Invoice merge-log consolidation, its `eval` condition field.

Added: e-invoicing (IRN) and e-way bills — both need the 16-character number
Phase 1 delivers, and neither is reachable until a shop crosses the turnover
threshold. Design nothing that blocks them; build neither.
