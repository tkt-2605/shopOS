# More than one device

Asked for as: *"find a way to reliably and robustly make this into a multi
device thing"*. This is the design, the findings behind it, and the one
decision that is not mine to take.

It is a round of its own — larger than everything currently planned put
together — so nothing here is built yet. What follows is what the codebase
already does right, what it does wrong, and the order to fix it in.

---

## Two different products wear the same words

**One shop, two or three tills.** Same room or same building, same stock, same
customers, one set of bill numbers. This is almost certainly what is wanted.

**Several shops, or the owner's phone away from the counter.** Branches with
their own stock, a device that is not on the shop's Wi-Fi. A different and
much larger problem, and one that needs a server somebody pays for.

Everything below is the first. The second is reachable from it, but it is not
the same job and should not be priced as if it were.

---

## Where this is going, decided

**A cloud server with many shops on it.** The local-only product is the first
lane, not the destination, and the design is to be made with the destination in
mind rather than retrofitted towards it.

### One database per shop, not one database for all shops

Decided, and it is the decision the rest of this document now rests on.

The alternative — every table carrying a `tenant_id`, every `UNIQUE` rewritten
as `(tenant_id, ...)`, every query in `packages/core` carrying a tenant
predicate — was rejected for four reasons:

- **The local database already is exactly one tenant.** Database-per-shop means
  the cloud schema and the local schema stay the *same schema*, migrated by the
  same hand-kept list. Shared-schema forks them on the first day and keeps them
  forked for ever.
- **Offline-first already forces the partition.** Each shop's database has to be
  independently complete to work with the internet down. That is tenant
  isolation, achieved as a side effect of something the product had to do anyway.
- **The one failure that ends this product is shop A seeing shop B's sales.**
  Row-level security is one forgotten `WHERE` away. A separate database is a
  wrong connection string away, which is far harder to do by accident and far
  easier to prove.
- **It is the cheaper mistake.** Shared-schema wins on idle cost somewhere past
  a few thousand shops. Going shared later — add `tenant_id`, merge — is much
  cheaper than splitting a shared database apart afterwards.

**What follows from it, and is now load-bearing:**

- `packages/core` never learns the word "tenant". No `tenant_id` column, no
  tenant argument, no tenant predicate. If one ever appears in a diff, this
  decision has been reversed by accident.
- Every existing global `UNIQUE` is already correct — `users.username`,
  `registers.prefix`, `roles.name`, `customers.code`, `product_barcodes.barcode`,
  `bills.doc_no`. Under one shared database every one of them would have been a
  cross-shop collision.
- A "device" in everything below is a till today and a **server process**
  tomorrow. The cloud is one more origin replicating with the shop's tills, not
  a different mechanism — which is what makes phases 0 to 3 work the shop pays
  for now and work the cloud is built on later.
- Per-shop authentication, billing and provisioning live **above** the database,
  in whatever serves it. None of it reaches `packages/core`.

---

## What is already right

This was designed for it. `001_initial.sql` says so in its own header, and the
schema keeps the promise:

| Already true | Why it matters when there are two tills |
|---|---|
| Every id is a **UUIDv7** | Two tills billing at the same second cannot mint the same key. This is the single hardest thing to retrofit and it was never a problem here |
| **Document numbers are per register**, per fiscal year (`nextDocNo`) | `FC/26-27/00012` and `TILL2/26-27/00003` cannot collide, even with no network between them |
| Ledgers are **append-only**; nothing is updated after submit, correction is cancel + amend | Facts merge by union. There is no "which version of this bill is right" question to answer, because a bill is never edited |
| `rev`, `origin_id`, `deleted_at` on 20 mutable tables | The columns a replicator needs — though see below: only one of the three was ever actually written |
| `SqlDriver` is an interface with two implementations already (`node-driver`, `tauri-driver`) | A third that talks to another machine is a seam that exists, not one that has to be cut |
| `stock_policy` is a shop-level choice of block / warn / allow | The hardest merge conflict — two tills selling the last one — already has a policy switch and an answer the shop chose |
| `EXPECTED_SCHEMA_VERSION` and `staleBuild()` | Two tills on different builds is the sync bug that corrupts data. The guard for it is already written |

## What is wrong today

- ~~**`setDeviceRegister` writes to `settings`**, which is a shared table. Two
  tills sharing a database would both claim the same counter and then overwrite
  each other.~~ *Moved to `device.json` — see Phase 0.*
- **There is no device identity.** `origin_id` is a column with nothing to put
  in it. Until a device knows its own name, no change can be attributed and no
  replication can decide anything. *(Answered by migration 019 — see Phase 0.)*
- **`rev` was a promise kept three times in eight.** 001's header says `rev` and
  `origin_id` are "written but not read until sync ships". `origin_id` was never
  written by anything at all, and `rev` was bumped by **16 of the 64** UPDATE
  statements in the service layer. Partially kept is worse than never kept: a
  merge resolving conflicts by comparing `rev` would have silently discarded
  every change made through the other 48 and would have looked like it was
  working. *(Answered by migration 019 — see Phase 0.)*
- **Nothing has ever been merged.** Every invariant in the product is enforced
  by a SQLite transaction on one machine. The moment two machines write, the
  transaction stops being the thing that protects the invariant.

---

## The decision that is not mine

### Option A — one database, the others are terminals

One machine holds `shop.db` and serves it over the LAN. The other tills run the
same app against a `SqlDriver` that speaks HTTP to it.

- **For:** no merge, ever. Every invariant the product has stays exactly as
  strong as it is today, because there is still only one transaction and one
  writer. Buildable in a fortnight and testable.
- **Against:** when the host is off, asleep, or the Wi-Fi drops, **the other
  tills cannot sell**. That is a direct contradiction of the thing this product
  is for. A shop that cannot bill because a laptop in the back office went to
  sleep will not use it twice.

### Option B — every till has the whole database, and they replicate

Each device is complete and works alone. They exchange changes when they can
see each other.

- **For:** it is the promise. Any till, any time, network or not.
- **Against:** merging is now the product's problem, and stock is the merge it
  cannot win by itself.

### The recommendation: B, with the scope cut honestly

B is the only one consistent with what this product claims, and the schema was
built for it. What makes it tractable is that **almost nothing here actually
conflicts**:

- Bills, payments, returns, stock entries, cash sessions and documents are
  **append-only facts with unique ids**. Merging them is a union. No algorithm,
  no vector clocks, no CRDT.
- Products, customers, prices, settings and users are **mutable, and edited by
  one person perhaps twice a week**. Last writer wins per row, decided by
  `(rev, origin_id)`, with both sides kept in `audit_log` so "who changed this
  price" still has an answer.
- **Stock is the only real conflict**, and it is not a merge problem — two
  people sold the same last unit and one customer is going home without it.
  No algorithm fixes that. What the product can do is exactly what it already
  does when a count is wrong: `stock_policy`. A shop on `block` gets a stricter
  reservation; a shop on `warn` finds out at the next sync and sees it on a
  list. That is the honest answer and half of it is built.

---

## Order of work

**Phase 0 — device identity. Built (migration 019).**

- `device_id` is minted on first run and kept in `device.json` **beside** the
  database, never inside it. Everything that happens to `shop.db` is a reason
  not to keep it there — it is backed up nightly, copied onto a replacement
  machine, restored from a six-month-old file, and will one day be replicated.
  An identity inside it would be cloned by every one of those, and two tills
  that each believe they are the same till cannot be told apart in any history.
  `backup.rs` copies with VACUUM INTO and `restore.rs` replaces the database
  file alone, so neither touches it: a restored database adopts the identity of
  the machine it lands on, which is true, rather than the one it came from,
  which is a lie written into every row created afterwards.
- **Every audit row carries the device.** `writeAudit` already runs inside the
  same transaction as every service write, so one line there covers the lot
  without threading an argument through forty signatures.
- **`rev` is bumped by a trigger**, on all 20 replicated tables. A convention 48
  call sites have to remember is not a convention, it is a list of future bugs —
  this schema had been proving that for eighteen migrations. The `WHEN NEW.rev =
  OLD.rev` guard means the 16 statements that were already correct do not now
  double-count.

**Deliberately not done in Phase 0:** per-row `origin_id`. It is the tiebreaker
a last-writer-wins merge needs, and it is only needed once a merge exists — and
because the audit trail now carries the device on every write, it can be derived
when that day comes. Writing it now would mean touching every INSERT in the
service layer for a column nothing reads, which is the exact mistake being
corrected above.

**Which counter this machine is** has moved off `settings` and into
`device.json` beside the identity. `resolveDeviceRegister(db, chosen)` keeps the
half that is a question about the database — whether that counter still exists
and is still open — and the choice itself is no longer in a table the whole shop
shares. A shop already running has the old `device_register_id` row and on a
single till it holds the right answer, so it is moved across once, in one
transaction with its own deletion: leaving it in both places is the state where
a second till would later pick up the first one's counter and mint its invoice
numbers.

**Still owed before two tills can share a database:** `settings` carries no
`rev` and no `origin_id` at all, yet it holds the shop name, the GSTIN, the
rounding rule and the stock policy — all things that have to replicate. It is
the one table that is replicated in practice and not in the schema, and it needs
a decision rather than a trigger, because two tills changing two different
settings must not overwrite each other's row.

**Phase 1 — the changefeed.** One table recording `(table, row id, rev, origin,
at)`, written by the same service-layer seam that writes the audit row. Sync
then has something to ask for that is not "diff two whole databases".

**Phase 2 — transport.** The host advertises itself on the LAN; a till pairs
with it once. A small HTTP server on the Rust side, no cloud, no account, no
subscription, consistent with everything else about this product. Pull, then
push, then apply in a transaction. **Refuse outright across schema versions** —
`EXPECTED_SCHEMA_VERSION` is already the guard and it must be checked before a
single row moves.

**Phase 3 — what a person sees.** When the tills last agreed, what has not gone
across yet, and the oversell list. A sync that is silent when it is working and
silent when it is not is a sync nobody trusts.

**Phase 4 — the second product.** Branches and the phone, over the internet,
with the same changefeed and a relay in the middle. Only once the LAN case has
run in a real shop for a season.

---

## What has to be tested, and is the reason to do it in this order

- Two databases, the same catalogue, both billing offline, merged: **no id
  collides, no bill number collides, both bills exist, both ledgers balance**.
- A row edited on both sides: the later one wins and **the earlier one is still
  in the history**.
- A till that has been off for a week catches up in one pass.
- Sync across two schema versions is refused with a sentence, and writes
  nothing.
- The last unit sold twice appears on the oversell list and the shop's
  `stock_policy` decides what the second till was told at the time.
