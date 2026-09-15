# Execution order — one developer, Claude Code, no deadline

Sequencing for the plan and the specs beside this file. "Blocks" means the
later item cannot be started safely; "alongside" means the two can be
alternated without stepping on each other.

## The sequence

| # | Item | Blocks | Alongside |
|---|---|---|---|
| 0 | **Day one, before any code**: order the OV certificate; generate and back up the updater key; write `tools/pull-shop-db` | Phase 4 signed release | everything |
| 1 | Phase 0 (half a day) | the bench package (tsconfig) | — |
| 2 | Test bench: clock seam, `virtual-till`, six scenarios, `shopos-net` crate | Phase 1d, Phase 2c, Phase 6 | Phase 1a–1c |
| 3 | Phase 1: migration 028 → 1a → 1b → 1c → 1d | Phase 2a (queries would be rewritten twice), Phase 5 GSTR-1 | Phase 3 (different files) |
| 4 | Phase 3 | the first outside install (log file) | Phase 1, Phase 2 |
| 5 | Phase 2a Drizzle by risk → 2c migrations → 2b driver | Phase 5's customer-buckets proof; Phase 6 (2b) | Phase 4's CI and updater code |
| 6 | Phase 4: CI → updater → licensing → portal skeleton → signed release | Phase 5 (features as updates), Phase 6 (portal) | Phase 2 |
| 7 | Layer 3 procedure: Sandbox install, update, restore, power cut | Phase 4 sign-off | — |
| 8 | Phase 5 in the spec's order, customer buckets last | — | the Phase 6 spike |
| 9 | Phase 6: spike → cloud peer → portal accounts → phone view → diagnostics → WhatsApp API | Phase 7 | — |
| 10 | Phase 7 | — | — |

## What is genuinely parallel

- **Phase 1 and Phase 3** touch different files: core services and renderers
  against Rust startup, backup and logging. Alternate days between them.
- **Phase 2 and Phase 4's code** (CI, updater, licensing) do not overlap;
  only the signed release waits on the certificate.
- **The bench's Layer 2 containers** can be built any time after the crate
  extraction; they are not on the critical path.

## What must not be parallel

- 1a–1c with 2a: Drizzle must not rewrite a query the GST fix is changing.
- 1d's host-sync fix with the bench's clock seam: the fix's test needs the seam.
- 2c's handshake with any sync change in 1d: land 1d first.

## Where the days go (for planning, not promising)

| Phase | Days |
|---|---|
| 0 | 0.5 |
| Bench | 4 |
| 1 | 10 |
| 3 | 5 |
| 2 | 8 |
| 4 | 6, plus the certificate wait |
| 5 | 15 |
| 6 | 12 |

The certificate's lead time overlaps everything. If it arrives before Phase 4
the release is same-day; otherwise Phase 5 starts unsigned in the Sandbox.

## The first outside install

Happens after row 7, not before. An unsigned build with no log file and no
updater at a stranger's shop is a visit per bug, which is what Phase 4 exists
to end.
