# ShopOS

Offline-first retail POS. SQLite at the counter, business logic in a TypeScript core
that runs identically in the app and in CI.

```
packages/core/
  migrations/     numbered SQL, immutable once released
  src/
    money.ts      integer paise
    quantity.ts   integer, scaled 10^4
    ids.ts        UUIDv7
    db/           driver interface, node + tauri drivers, migration runner
    domain/       pure functions: tax, pricing, loyalty, credit, valuation
    integrity/    docstatus, permissions, link checks, audit
    services/     transactional use cases
apps/pos/
  src-tauri/      Rust: rusqlite command layer, transaction watchdog
```

```bash
npm install
npm test                              # 192 tests
npm run typecheck
cd apps/pos && npm run tauri:dev      # needs Rust + MSVC build tools
```

## Two drivers, one interface

`SqlDriver` has two implementations and the services never know which they have:

- **`node-driver.ts`** — better-sqlite3. Tests, seeds, CLI. Never bundled; the app's
  Vite config aliases `better-sqlite3` to an empty module so a stray import fails at
  build time rather than confusingly at runtime.
- **`tauri-driver.ts`** — `invoke()` into the Rust layer. Ships in the app.

`MIGRATIONS` reads `.sql` files with `node:fs`, so it is exported from
`@shopos/core/migrations` rather than the main entry, keeping `node:fs` out of the
webview bundle.

## The transaction held across IPC

Rust keeps one connection behind a mutex and one transaction at a time, identified by
a token. Statements carrying the wrong token are rejected, so a stale call cannot
commit someone else's work.

The risk is a JavaScript exception between begin and end stranding the connection and
freezing every later query. Two defences: the TS driver ends the transaction in a
`finally` on every path, and Rust rolls back anything still open after 15 seconds. The
watchdog is the backstop, not the plan.

## Rules that are not negotiable

**Money is integer paise. Quantity is integer scaled 10⁴. Tax rates are basis points.**
No floats anywhere near a total. `money.allocate()` splits an amount by weights without
losing a paisa — use it for any apportionment rather than multiplying by a ratio.

**Documents have a lifecycle.** `docstatus` is 0 draft / 1 submitted / 2 cancelled.
A submitted document is never updated — it moved stock and took money. Correction is
cancel, then amend into a new document that links back via `amended_from`. Only
submitted documents post to ledgers.

**Ledgers are the truth; balances are a cache.** `stock_ledger`, `loyalty_entries` and
the payment allocations are append-only. `product_stock` and any customer balance are
materialised for speed and must be rebuildable, with a drift report, from the ledger
alone. Never store a balance you cannot recompute.

**Nothing referenced is ever hard-deleted.** Check `integrity/links.ts` before any
delete and tell the user where the references are. Masters get `deleted_at`, not `DROP`.

**History does not move.** Bill lines snapshot product name, rate, tax rate, HSN and
unit at submit time. Editing a product must never change what a past bill says.

**Every price records why.** `bill_items.price_source` and `price_source_id` carry the
rule that produced the rate. Resolution order: customer override → customer's price
list tier → default list tier → product base rate.

**Audit is append-only** and enforced by trigger, not convention. `writeAudit` takes the
caller's transaction handle so a rolled-back change leaves no row claiming it happened.

**Permissions are data.** Roles, per-resource capabilities and page visibility live in
tables the owner edits. Nothing about who-sees-what is hardcoded, and the sidebar and
route guard read the same source.

## Migrations

Numbered, contiguous from 1, tracked in `PRAGMA user_version`. **Never edit a released
migration** — two shops on the same version would have different schemas. Add a new file
and register it in `src/db/migrations.ts`.

## Comments

Explain why, not what. A comment earns its place when the code encodes a decision that
isn't visible from reading it — a rounding rule, an ordering that matters, a constraint
that exists because of a specific failure. Trivial restatement is noise.
