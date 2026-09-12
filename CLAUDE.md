# ShopOS

Offline-first retail ERP for Indian shops. Windows desktop, Tauri 2 + React + SQLite.
ERPNext is the reference model, not the foundation. Built solo. This is product v1.

## Shape

- `packages/core` — all business logic, pure TypeScript, no Tauri imports.
  `domain/` is pure and DB-free (pricing, tax, money, billTotals); `services/` takes a
  `SqlDriver` and runs transactions; `repos/` is queries; `migrations/` is numbered SQL,
  each file also listed in `src/db/migrations.ts` (a test enforces the list matches the folder).
- `apps/pos` — the React app. `src-tauri` is the Rust side: SQLite, printing, files, backup.
- `design/` — a Python generator that produces `.dc.html` artboards for the design canvas.

## Rules that are not negotiable

- Offline-first. The counter works with the line down. No fetch from the webview
  (CSP `connect-src` inherits `'self'`); network code lives in Rust.
- Money is integer paise, branded `Money`. Quantities are scaled x10^4 (`QTY_SCALE`).
  Tax is basis points. Never floats.
- Dates that name a business day come from `businessDate()`, never `toISOString().slice(0,10)`
  — that is UTC and files an 00:30 IST bill against yesterday.
- Documents follow ERPNext's docstatus: 0 draft, 1 submitted, 2 cancelled. Submitted is immutable.
- Ledgers are append-only; caches are materialized and have drift detectors.
- Valuation stores *value* and derives rate, never the reverse.
- Modular: code should come apart like a car — parts you can pull out and replace.
- No rounded corners anywhere, including inputs.
- In prose to the user: sparing bold.

## Working agreements

- `npm test` from the root runs the core suite (326 tests). Types: `npm run typecheck`.
- Any new migration needs a backfill if it adds a column existing rows should not read as zero.
- Before adding a feature from ERPNext, check the "deliberately not building" table in the plan.

## The plan

`C:\Users\user\.claude\plans\bright-kindling-snail.md` — approved v1.1 plan, nine parts.
Build order agreed with the owner: corrections, then seams, then features.
Parts 1 and 1.2/1.3 are done and committed. Next up is Part 1.4/1.5:
restore, the migrate downgrade guard, and the zip backup format.

## Design canvas

https://claude.ai/code/artifact/b21e0a12-bb18-4d2f-b6bc-82e379bf1bab
Two pages: Screens (the eight built pages + payment dialog), Proposals (Items & Pricing,
type options). Regenerate with `python design/build.py && python design/build2.py && python design/build3.py`,
then re-seed and republish per the design skill. Three comment threads are still open:
fonts, "items and pricing look so simple", item grouping.
