# Support kit

How the vendor finds out something is wrong at a shop, sees what happened,
reproduces it, puts it right and ships the fix, without a visit and without
ever stopping the counter. Written 16 Oct 2026, before cloud (Phase 6), and
meant to serve every shop, including the ones that never buy Cloud.

## What "professional" means here

A support operation that customers trust can do eight things. They are the
outline of this spec:

| # | Capability | The question it answers |
|---|---|---|
| 1 | Identify | Which shop, which till, which version, in one sentence a shopkeeper can read out |
| 2 | Monitor | Is anything wrong before the shop rings? |
| 3 | Observe | What happened at 14:32 on till 2, four hours ago? |
| 4 | Obtain | Can I have the data, with the owner's consent, safely? |
| 5 | Reproduce | Can I make it happen here? |
| 6 | Repair | Can I put this shop's records right without SQL down a phone line? |
| 7 | Release | Can I fix one shop, stop a bad release, switch off a broken feature? |
| 8 | Run it | Tickets, response targets, runbooks, help articles, privacy and the audit of what support did |

## Today

Already built, and the base for everything below:

- **Logs.** `src-tauri/src/log.rs`: a rotating log (5 × 1 MB) with a panic hook, and no secrets in it.
- **Health report.** `health.rs` and `core/health.ts`: a daily report that carries no customer, no money and no credential. It holds sync peers, set-aside records, conflicts, integrity, counters, licence state and the kinds of discrepancy found. It goes out by the shop's mail or Telegram, or by the vendor's baked-in bot (@shp0s_bot).
- **Diagnostics bundle.** `diagnostics.rs`: a richer zip, redacted on an allowlist. The shopkeeper saves it and sends it by hand. The Help card (`HelpSection.tsx`) says plainly that nothing is uploaded.
- **Fixes the shop can make itself.** Needs Attention, with a remedy for each double entry (`discrepancies/remedies.ts`). Reconcilers for the cached figures. Records that cannot land are set aside rather than lost. A recovery code for a forgotten password. A till restored from an old backup is detected.
- **Copying a shop's database.** `tools/pull-shop-db.mjs` takes a VACUUM INTO copy of a database.
- **Releases.** Targeted, held and percentage rollouts through `tools/release.ts target`. Updates are never forced.
- **Reproducing.** The WSL netns bench, virtual tills, `compare.ts` and the soak and catch-up tests.

The gaps: the vendor learns of a problem only when it is reported, one Telegram message at a time. The data reaches the vendor by hand or not at all. Every repair is a remote-desktop session and hand-typed SQL. There is no way to switch a broken feature off short of shipping a release. And none of the process is written down.

## Principles

1. **Nothing in the kit can stop a sale.** Every support path is best-effort and swallows its own failures, as `log.rs` does.
2. **Signals by default, data by consent.** The health report names no customer and goes out every day. Anything carrying records leaves only when the owner presses a button for it, is encrypted so that only the vendor can open it, and is deleted on a date.
3. **Repairs are named operations, never SQL.** The vendor ships a signed repair. The till shows in plain words what it will change, backs up first, applies it in one transaction and writes an audit row. Each repair is an operation in core with tests, like any other service.
4. **Everything support does is recorded,** on the till (the audit table) and on the portal (a support log). That record is what makes a customer comfortable with "support can see my data".
5. **No new dependencies.** The `ring` crate is already in the lockfile and does X25519, ChaCha20-Poly1305 and Ed25519 verification. The portal stays on `node:http` and `node:crypto`.
6. **Indian law is the floor.** Under the DPDP Act 2023 the shop is the data fiduciary for its customers' records and the vendor is its processor. That means consent that is specific and recorded, use for one stated purpose, deletion on a date, and a notice the owner can read.

## The kit

### 1. Support ID and the Help screen (identify)

- **A support code per till:** `0192 f4a1 · FC · 0.3.0`. The shop part is the short shop id (`shortShopId`, the first eight characters of the shop id). It is the same id already on every report, on the Licence screen and in `release.ts target --only`, so there is one name for a shop wherever it is looked up. The till part is its counter's prefix, as on its bill numbers.
- **A Get help screen,** opened from the sidebar footer by anybody signed in, not only the owner. It shows:
  - the support code, with a Copy button;
  - the vendor's phone and WhatsApp numbers, baked in at build like the bot;
  - later, "Last report sent: today 21:30";
  - later, the three actions below: Send a report now, Send my data to support, Apply a fix from support. Saving a report stays on Settings → Help, which is the owner's.
- **A WhatsApp link** opens a chat already filled in with the support code. That is how Indian shops already talk to vendors. The address is built in Rust from the number baked in at build; the webview hands over only the words.

Built 16 Oct: `ui/GetHelp.tsx`, `core/support.ts` and `src-tauri/src/support.rs`, with the number from `SHOPOS_SUPPORT_PHONE` / `SHOPOS_SUPPORT_WHATSAPP` in `.env`.

Size: 1 day.

### 2. Fleet health on the portal (monitor)

The health report also goes to the portal, not only to Telegram.

- **On the portal:**
  - `POST /v1/shops/:id/health`, signed with the till's licence identity. It takes the same zip, with no customer, money or credential in it.
  - The portal keeps the latest report per till, and a short history of the numbers: sync lag, set-aside count, conflicts, discrepancy kinds, version, integrity result.
- **Fallback:** queued in Rust and retried, like mail. When the portal cannot be reached, Telegram still carries it.
- **Alert rules,** in portal code with tests:

| Signal | Rule | Severity |
|---|---|---|
| Quiet | no report from a till for 48 h (it may simply be shut; one rule, one note) | P3 |
| Integrity | `quick_check` not `ok`, or foreign-key problems | P1 |
| Stuck sync | a peer's `last_agreed_at` older than 24 h while both tills are reporting | P2 |
| Set aside | records set aside and not acknowledged for more than 24 h | P2 |
| Books | submitted bills without `gl_entries` above 0 | P1 |
| Discrepancy | a new kind appears (paid twice, refunded twice ...) | P3 |
| Clock | skew over 5 minutes | P3 |
| Version | a till more than two releases behind, or a shop on mixed schema | P3 |
| Licence | expiring within 14 days, or failing to verify | P2 |
| Crash | see 3 | P1–P2 |

- **A morning digest** goes to the vendor's own Telegram chat: P1 and P2 items, each with the support code and a link to the console.
- **A console:** `/console` on the portal, behind the vendor's own sign-in. It is plain HTML rendered on the server, with no framework. It has:
  - the fleet, by shop: plan, tills, versions, last heard, open alerts;
  - one shop: each till's latest report, readable, with history;
  - releases: who is on what, crash counts by version.

Decision needed: `diagnosticsUpload` is gated to Cloud in `domain/licence.ts`. The health report serves the vendor and carries no records, so this spec treats it as ungated, and keeps the gate for 4 (records). Confirm, and update the licensing spec.

Size: 4–5 days. This is the piece that turns support from reacting to reports into watching the fleet.

Built 16 Oct. The owner decided every shop sends, on every plan; the `diagnosticsUpload` gate stays for part 4.

- **Till** (`src-tauri/src/portal_out.rs`):
  - The health report goes to `SHOPOS_PORTAL_URL`, built in like the bot, or a machine's `portal_url` setting. It is sent as JSON without the logs, from its own queue in `outbox-portal/`, retried with the outbox.
  - The first report is answered with a key. The till keeps it in `portal-key` beside the database and sends it after that.
  - A build with a portal sends health daily whatever the shop has set up.
- **Portal** (`apps/portal/src/health/`, `routes/support.ts`, `console/`):
  - `POST /v1/shops/:id/health` takes up to 2 MB. It keeps 60 reports per till, with a summary the rules read.
  - The alert rules are the table above. The digest goes to `SHOPOS_DIGEST_TOKEN`/`SHOPOS_DIGEST_CHAT` after 08:00 IST, once a day, logged in `support_log`. `cli.ts digest` sends it now.
  - `/console` is for phones listed in `SHOPOS_VENDOR_PHONES` (`+91…:admin`). It offers the fleet, one shop, a raw report and Forget key, and every look at a shop is logged.

Not yet: the portal hosted (a VPS, a domain and TLS). Until then it is tried on this machine (`npx tsx apps/portal/src/cli.ts serve`). Tills on builds older than this send nothing to the portal; they appear once they update.

### 3. Crash and error reporting (observe)

- **Rust:** the panic hook in `log.rs` already writes the panic. Add a crash marker that the next start reads, so the health report says "crashed at 14:32, signature X".
- **Webview:** a top-level error boundary plus `window.onerror` and `unhandledrejection`. Each error is written to the log through Rust with:
  - a signature: the message with ids and numbers stripped, plus the top frame of the stack;
  - a count;
  - the page the user was on.
- **Service refusals:** codes like `HAND_OVER_FIRST` and `PERIOD_CLOSED` are logged as counted events. They are not crashes, but a spike in them is a usability bug.
- **Errors in the health report:** grouped by signature and version. The portal groups them across the fleet, which is in effect an in-house Sentry with no dependency.
- **Release health:** crash-free sessions per version. When a new version falls more than 2 points below the previous one, the console flags it and `tools/release.ts` refuses to widen the rollout until someone passes `--despite-crashes`.
- **Source maps:** kept by the release build (not shipped), so that stacks can be read on the vendor's machine.

Size: 3 days.

Built 16 Oct, the till's side (`src-tauri/src/faults.rs`):
- `faults.json` in the data folder counts each version's runs as started, clean, panicked or unclean. Unclean is a power cut or a killed process, counted apart from a crash because in a shop without a UPS it is not a bug.
- Every error the log writes, from Rust or the webview, is counted by signature: the first line with numbers, ids and quoted values taken out, plus the top stack frame for the webview. The 100 kinds seen most recently are kept, with first and last time and a count. An error's own words are never kept, so a quoted customer name never reaches the report.
- The health zip carries `faults.json`, and its caption gains a line such as `0.3.0: 12 run(s), 1 crash(es), 2 ended without closing, 3 kind(s) of error`.
- An update marks its run clean before the installer closes the app.
- Release builds make hidden source maps and move them to `apps/pos/sourcemaps/<version>/`; `release.yml` keeps them as a 90-day artefact of the run.

Left for later: the page the user was on, the counted service refusals, and the release-health gate. The gate needs the portal (part 2), which is where versions are compared across shops.

### 4. Send my data to support (obtain)

The single biggest gap. Today the vendor sees a symptom and guesses.

- **The button,** on the Help page: "Send my data to support".
  - The screen says what goes (the whole shop database), why, who can open it (the vendor only), and when it is deleted (30 days).
  - It needs the owner's role and their password again.
- **Packing:**
  1. VACUUM INTO, as `pull-shop-db.mjs` does.
  2. Then strip what support never needs: `users.password_hash`, `sync_peers.secret`, the licence keys and every device setting outside the allowlist.
  3. Then encrypt to the vendor's public key: X25519 key agreement and ChaCha20-Poly1305 from `ring`, with the till's public key in the header.

  The private key never leaves the vendor's machine. It is not on the portal, so a portal breach yields only ciphertext.
- **Delivery:**
  - Upload to the portal: chunked and resumable, because the line is poor. It is stored with a delete-by date.
  - Or saved as a file to send by WhatsApp or Drive when there is no line.
  - Both are the same encrypted file.
- **Recorded:** an audit row on the till ("data sent to support, ticket 142, by Ravi"), and on the portal: received, opened by whom and when, deleted.
- **Customer records:** a "without customer details" choice replaces customer names, phones, GSTINs and addresses with stable placeholders before encrypting. It is the default when the problem is not about customers.

Size: 4 days, including the portal side and the decrypting tool.

Built 16 Oct.
- **Till** (`src-tauri/src/support_data.rs`, Settings → Help → Send my data to support):
  - It needs the owner's password again, and writes an audit row.
  - The copy is made with VACUUM INTO and scrubbed under `secure_delete`, with `sync_state.applying` set so the change feed does not move, then vacuumed. "Leave out customer details" is on by default and keeps each customer's placeholder the same everywhere they appear. Notes typed by staff stay; the card says so.
  - It is sealed with `ring` to `SHOPOS_SUPPORT_PUBKEY`: X25519, HKDF-SHA256 and ChaCha20-Poly1305 in 64 KiB chunks, the last marked. A build without the key says so and offers nothing.
  - It is sent in 768 KiB parts with the till's health key. A broken upload carries on where it stopped. "Save to a file instead" works with no line at all.
- **Portal** (`data/`, `routes/data.ts`):
  - It holds ciphertext under `SHOPOS_PORTAL_FILES`, checks the SHA-256 the till gave, and deletes a file 30 days after it arrives (7 if abandoned). The row stays.
  - Downloading needs the `support` role and is logged.
- **Vendor:**
  - `tools/support/keygen.ts` makes the pair and refuses to write the private half inside the repository.
  - `tools/support/open.ts` opens a file into `shop.db` and `manifest.json`.
  - `tools/support/test/fixture.sod`, sealed by the Rust code, holds the two sides to one format.
- **Checked by hand on till 4's own database:** sealed, uploaded through the real sender, opened by the tool. Integrity is ok and every table's row count is unchanged. No password hash is left, none of the real customer names or phones is in the file, and the books still balance.

### 5. The support workbench (reproduce)

`tools/support`, a command-line tool on the vendor's machine:

- `support open <file>`: decrypts, migrates a copy to the current schema, and writes a one-page report. The report runs:
  - every discrepancy check;
  - every reconciler, in dry-run mode, showing what drift each would correct;
  - integrity and foreign-key checks;
  - books balance (debits equal credits per voucher);
  - stock by ledger against the cache;
  - the change feed and set-aside records explained in words.
- `support diff <a> <b>`: two tills' databases compared by row, using `compare.ts` from virtual-till. It answers "why do these two tills disagree".
- `support bench <file> --tills 3`: starts virtual tills seeded from the shop's database, so the problem can be replayed on the WSL bench.
- `support timeline <file> --doc INV/2627/00042`: everything that touched one document — audit rows, feed rows, conflicts, set-aside entries — in time order. This is the most-used command in practice.

Everything it does goes through core, so it gives the same answers as the till.

Built 16 Oct, as `tools/support/support.ts`:
- **`check`:**
  - The database's integrity and foreign keys.
  - The books, voucher by voucher.
  - Every reconciler asked what it would change: stock, returned and billed quantities, loyalty, and stock reversed twice.
  - Needs Attention, gaps in bill numbers, sync (peers, set-aside records, clashes, the feed by origin) and the counters' claims.
  - It exits 2 when anything needs a look; `--json` gives the same for a ticket.
- **`timeline`:** the record, its audit rows, feed rows, clashes, set-aside entries, book and stock postings, and the returns and payments against it, in time order.
- **`diff`:** the soak's whole-row comparison (`virtual-till/src/books.ts`) pointed at two real files.
- **Inputs:** each takes a `.sod`, a folder `open.ts` made, or a `shop.db`. It works on a copy brought up to the current schema, and the file given is never written to.

Run on till 4's own database: every section ok, the file's hash unchanged after, and its first bill's history read back from creation to the books.

Left out: `bench`. A shop's database seeded into several virtual tills needs each one given its own device identity and paired, which the virtual till cannot yet do from an existing file. Until then, a case that needs replaying is rebuilt on the bench by hand from what `timeline` shows.

Size: 4 days.

### 6. Repair packs (repair)

**What a pack is.** A signed file that names repairs from a fixed list, with their inputs, for one shop.

**Core:** `services/repair.ts` holds the list. Each entry is a function with a preview, a permission and tests, as remedies are. A starting set:

| Repair | Puts right |
|---|---|
| `reconcile` | re-runs one or all reconcilers (returned/fulfilled quantities, stock cache, outstanding) |
| `release_set_aside` | retries or drops one set-aside record, with its reason |
| `free_counter` | clears a counter's claim held by a till that has been dead for good |
| `reset_peer_cursor` | asks a peer for everything again from a sequence |
| `renumber_from` | moves a counter's next document number past a number that has been seen |
| `cancel_document` | cancels a named bill, return or payment through its own service, with a reason |
| `set_setting` | a setting from an allowlist |
| `rebuild_feed` | rebuilds the change feed from the tables (the last resort before a re-join) |

**On the till** (Help → Apply a fix from support):

1. Verify the Ed25519 signature against the vendor key baked in at build.
2. Check that the shop id matches and the expiry date has not passed.
3. Show the preview in plain words, for example "Counter 'Front' will be freed. 3 set-aside records will be retried."
4. The owner's password.
5. A backup.
6. Each repair in its own transaction, with an audit row naming the pack id.
7. A result screen, and the result is sent back in the next health report.

**No arbitrary SQL in a pack.** A new kind of breakage becomes a new repair in the next release. Until then it is a remote session (7), recorded as such.

**Packs that stop working:** a pack is used once and expires in 7 days. One sent for shop A is refused at shop B.

**Making a pack:** `tools/support pack --shop <id> --repair free_counter --counter <id>` signs it with the vendor's private key. The portal can hand it to the till, or it travels as a file.

Size: 5 days for the frame and the first five repairs.

Built 16 Oct.
- **The pack** (`domain/repairPack.ts`) is the licence's shape: base64url JSON, a dot, and an Ed25519 signature over the first part's text.
  - It is checked against `REPAIR_KEYS` in `config/repairs.ts`, which is empty until the owner makes a key; until then every pack is refused as NOT_CONFIGURED.
  - It names one shop, ends on a date, and is used once for the whole shop, recorded as a setting so every till knows.
- **The repairs** (`services/repair.ts`): `reconcile`, `retry_set_aside` (the merge's own retry, marked as remote), `free_counter`, `renumber_from` (only ever forward) and `reset_peer_cursor` (only ever back).
  - Each has a preview in words. A pack with any part that does not fit this shop is applied not at all.
  - Each repair is its own transaction with an audit row naming the pack and the case. One that fails stops the rest and leaves the pack unused.
- **The till:** Settings → Help → Apply a fix from support. The owner pastes the text, reads what it will do, gives the password, and a backup is taken before it is applied. There is no file picker and no portal delivery yet: the pack is text, and WhatsApp carries it.
- **The vendor:**
  - `tools/support/keygen.ts --repair` makes the Ed25519 pair.
  - `tools/support/pack.ts --shop … --ticket … --repair kind:field=value` signs a pack, after reading it back with the tills' own parser, so a pack the tills would refuse is never made.
- **Not yet:**
  - `rebuild_feed` and `set_setting`.
  - A repair that renumbers a bill which has been set aside.
  - Applying a pack from the sign-in screen, for an owner locked out with no recovery code.

### 7. Remote session (the last resort)

Don't build one. Use RustDesk (open source, can be self-hosted later) or AnyDesk:

- The Help page has a "Start remote help" button that opens whichever the shop has installed, or says how to get it.
- The policy is written in the runbook:
  - only with the owner present;
  - outside billing hours where possible;
  - a backup first;
  - logged in the ticket.
- Any SQL typed in a session is pasted into the ticket.
- Every remote session that ends in a hand repair produces a new entry in 6, so the same repair is never typed twice.

Size: half a day.

### 8. Release safety (release)

Already planned in `update-rollout.md`. The kit adds:

- **Kill switches:** a signed `flags` field in the manifest the updater already reads.
  - It turns a named feature off at named shops or every shop, for example `telegram_auto` or `orders_to_bills`.
  - Only features registered as able to be switched off can be. Taking money never can.
  - The app reads flags at start and on each update check.
- **A hotfix lane:** a branch from the release tag, `release.ts target --only <shop>` straight away, and widened after 24 h with no crash change.
- **A pre-release gate:** the soak (seeds 1, 7, 31) and the catch-up test run against the release build, and the release is refused when either fails. The nightly workflow already exists; this makes it blocking.

Size: 2 days.

Built 18 Oct, with three changes from the plan above:
- **Switches, not manifest flags.** The updater plugin hands over `latest.json` only when there is a newer version, so a shop already up to date would never see a flag. Instead:
  - A switch board (`core/domain/switches.ts`) is signed with the repair key by `tools/support/switches.ts` and put out with `cli.ts switches`. The portal serves it at `GET /v1/switches`.
  - Tills fetch it at start and every half hour (`portal_out.rs`), check it against `REPAIR_KEYS`, keep it on the machine, and take only a newer one.
  - What can be switched off: the catching-up screen, the weekly stock recount, the evening report pack, and the Needs Attention banner. A board naming billing, payments, returns, cash, sign-in or sync is refused whole.
- **Crash gate.** `release.ts target` will not widen a rollout while the release's crash-free share is more than 2 points below the release before it, once at least 20 runs have ended. It reads the figures from the portal's `GET /v1/releases` (admin token). Power cuts are left out of the figures. `--despite-crashes` overrides it. Narrowing and halting are never held up.
- **Hotfix and soak.**
  - `release.ts hotfix vX.Y.Z --shops <id>` checks the tag is the next patch, cut from the release it fixes, then tags it with its shops in the message. `release.yml` reads them, so the build goes first to those shops only.
  - The soak (500 steps) and catch-up (1,000 sales) now run in `release.yml` before the build, which waits on them.

### 9. Running support (process)

Not code, and just as much a part of the kit:

- **One inbox:** WhatsApp Business on a support number, plus a ticket tracker. A GitHub Issues board in a private repository is enough to start: one issue per case, labels for severity and area, and the support code in the title.
- **Severity and response targets,** written down and told to customers:

| Severity | Meaning | First reply | Target to resolve |
|---|---|---|---|
| P1 | Cannot bill, or books wrong | 1 h, 9–9 every day | same day |
| P2 | Sync stuck, a till unusable, a feature broken | 4 h, business hours | 2 days |
| P3 | Wrong figure in a report, a usability bug | next business day | next release |
| P4 | Question or request | 2 business days | — |

  Billing works offline on one counter, so a true P1 is rare. That is worth saying in the sales material.
- **Runbooks:** `docs/support/runbooks/`, one page per known problem, giving the symptom, how to confirm it (which report field) and the fix (which repair). The first ten are already known from this project's findings:
  - till restored from a backup;
  - counter claimed by a dead till;
  - duplicate document numbers;
  - paid twice;
  - refunded twice;
  - clock wrong;
  - licence won't verify;
  - Windows network prompt;
  - disk full;
  - forgotten password.
- **Help articles for shopkeepers:** a short, illustrated page per common task and problem, in English and Tamil to start. The Help page links to them, and they open from a copy bundled with the app, so they work offline.
- **Release notes in plain words,** shown once after an update.
- **A status line** on the portal's home page for vendor-side outages (portal, licences, cloud).
- **Incident reviews:** for every P1, a one-page note within 48 h covering what happened, the effect, why it happened and what stops it happening again, filed in `docs/support/incidents/`. Most fixes in this project began as exactly that.
- **Onboarding check at install:**
  - recovery code written down;
  - backup folder set;
  - report destination set;
  - support number saved in the shop's phone.

  Each is a check the Help page shows as done or not done.

### 10. Governance

- **A privacy notice and a short processing agreement** that the owner accepts when they register on the portal. They say what the health report holds, what a data upload holds, who sees it, and when it is deleted.
- **A support log on the portal:** every console view of a shop, every data file opened, every pack made, by whom.
- **Data deleted on a date:**
  - data uploads after 30 days;
  - health history after 12 months;
  - the deletion job tested like any other.
- **Keys:**
  - The vendor's encryption key and signing key are separate from the release-signing key and the licence key, and stored offline.
  - A rotation plan: the till accepts two signing keys, the current and the next.
- **A second person:** console roles (view, open data, make packs) exist from the start, so hiring help is a setting and not a rewrite.

## Order

| Stage | What | Days | Why this order |
|---|---|---|---|
| S1 | Support code and Help page (1), remote-help button and policy (7), first ten runbooks (9) | 2 | cheap, and every later piece points at them |
| S2 | Crash and error capture (3, the till side) | 2 | starts collecting before anything is there to read it |
| S3 | Health to the portal, alerts, digest, console (2), crash grouping (3, the portal side) | 5 | the move from waiting to be told to knowing |
| S4 | Send my data, encrypted (4), workbench (5) | 8 | the end of guessing |
| S5 | Repair packs and the first five repairs (6) | 5 | the end of hand-typed SQL |
| S6 | Kill switches, hotfix lane, blocking soak (8) | 2 | |
| S7 | Help articles, release notes, privacy notice, support log, deletion (9, 10) | 3 + writing | |

About five to six weeks of building in all. S1–S3 are worth doing before the first paying shop beyond the trial shops. S4 and S5 are worth doing before about 20 shops, or before cloud, whichever comes first. Cloud then adds a live copy of each Cloud shop's database, which the workbench reads like any other file.

## Verification

- [ ] The health report reaches the portal from a till behind a dropped line, once the line returns, and Telegram carries it while the portal is down
- [ ] Each alert rule fires on a fixture made to break it, and stays silent on a healthy shop
- [ ] A webview error and a Rust panic both appear in the next health report with the same signature as on the console
- [ ] A data upload interrupted at 60% resumes and decrypts, and the portal holds only ciphertext
- [ ] An uploaded file carries no password hash, peer secret, licence key or disallowed setting (asserted by a test on the packed file, as `diagnostics.rs` does)
- [ ] With "without customer details", no customer name, phone or GSTIN appears anywhere in the file
- [ ] `support open` on the trial shop's database reports the same discrepancies as that shop's Needs Attention
- [ ] A repair pack for shop A is refused at shop B, refused after expiry, refused a second time, and refused with one byte changed
- [ ] Every repair has a backup taken before it, and an audit row naming the pack
- [ ] A kill switch turns off a feature at one shop only, and a flag naming bill payment is refused by the app
- [ ] `release.ts` refuses to widen a rollout whose crash-free rate dropped
- [ ] Every data upload is deleted on its date, and the support log says so

## Open decisions for the owner

1. Health report ungated (this spec) or kept with `diagnosticsUpload` on Cloud.
2. Support hours and the response targets above: whether they are promised, and to which plans. Common practice: P1 for every plan, and faster targets for Cloud.
3. RustDesk or AnyDesk for the remote session.
4. Tickets on GitHub Issues to start, or a help desk (Freshdesk has a free tier, but it is another online account for customers).
5. Languages for help articles after English and Tamil.
