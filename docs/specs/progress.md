# Progress

Branch `phase-0-and-the-test-bench`, 11 commits, not pushed. Everything below
is on this machine only.

State of the tree: **1109 TypeScript tests** passing and 3 skipped (Phase 2c
placeholders that fail loudly if un-skipped early), **73 Rust tests** passing
with zero warnings, typecheck clean across core, app and bench, and Layer 2 of
the test bench green in Docker.

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

### Pulled forward out of order

- **Phase 1d's host-sync fix.** The bench demanded it: `host-initiates.test.ts`
  fails against the tree without it, and `npm test` may not stay red. Failing
  output kept at `evidence/host-initiates-before-1d.txt`.
- **The CGST/SGST fix**, applied on the owner's instruction ahead of Phase 1a.

---

## What the real database changed

`findings-real-shop.md` has all six findings. Three affect the plan:

1. **CGST ≠ SGST on 29 of 51 lines.** Not in any spec. Fixed.
2. **The shop charges GST with no GSTIN set.** Phase 1's scheme rule will
   default it to `unregistered` and stop charging tax. Correct, and a visible
   change on the day the migration lands. If TRT is registered, the GSTIN must
   be entered *before* the upgrade.
3. **This database cannot exercise the inter-state path.** Every customer is
   `'33'` — the fabrication the plan predicted — and the shop is also `'33'`,
   so the fabrication and the truth coincide and `SUM(igst_amount)` is zero.
   Phase 1's IGST verification has to be staged by hand.

---

## Left

### Phase 1 — the bills have to be right (next, ~10 days)

Migration 028 → 1a → 1b → 1c. 1d is done. The largest phase and the one with
the least tolerance for "close enough": the invoice snapshot columns, the tax
scheme as a shop setting, Rule 46(f), the A4 invoice with the rate-wise
summary, credit-note printing, and the eight switches in 1d that are on and do
nothing.

**Blocked on nothing.** Its verification is not: five of its eight checks need
the owner's database with things staged by hand.

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
