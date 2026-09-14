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

**`sync_queue` is reserved, not built.** It has existed since `001_initial.sql`
with a unique partial index and a status machine, and nothing has ever written a
row to it or read one. It is listed here rather than quietly left in the schema
because it is the same shape as the faults this document is about — a thing that
looks finished and does nothing — and a reader who finds it is entitled to know
which. The table shape is a guess made on day one; Phase 1 should expect to
replace it rather than fill it in.

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
a last-writer-wins merge needs, and it is only needed once a merge exists.
Writing it now would mean touching every INSERT in the service layer for a
column nothing reads, which is the exact mistake being corrected above.

An earlier version of this paragraph added that origin could be *derived* from
the audit trail when the day came. That is false and worth recording as false:
`bootstrap.ts` and `seed.ts` write no audit rows and between them insert into
ten of the twenty-one rev-bearing tables. The consequence is small — under one
database per shop a replica never re-bootstraps, because `bootstrap` keys on
`SELECT id FROM roles WHERE name = ?` and finds the replicated rows — but the
argument for deferring should not rest on it. The argument that holds is that
the merge will be written knowing which rows predate it.

**Which counter this machine is** has moved off `settings` and into
`device.json` beside the identity. `resolveDeviceRegister(db, chosen)` keeps the
half that is a question about the database — whether that counter still exists
and is still open — and the choice itself is no longer in a table the whole shop
shares. A shop already running has the old `device_register_id` row and on a
single till it holds the right answer, so it is moved across once, in one
transaction with its own deletion: leaving it in both places is the state where
a second till would later pick up the first one's counter and mint its invoice
numbers.

**`settings` was not one thing**, and migration 020 splits it (Phase 0 again).

The shop's own rows — name, state code, stock policy, rounding rule, loyalty
programme, every feature switch — now carry `rev` and `origin_id` with a
trigger, so `settings` stops being the one table a merge has to special-case.
One row per setting was already the right granularity: two tills changing two
different settings never collide, and the same setting changed twice is a real
disagreement that someone has to lose, which is exactly what row-level
last-writer-wins decides.

Five rows were never the shop's business and went to `device.json` instead:

| Row | Why it is the machine's |
|---|---|
| `thermal_printer` | The printer plugged into *this* till. Shared, the second till prints on the first one's printer, or on nothing |
| `backup_hook` | A command that carries this machine's backup to a USB stick, a NAS share or a syncing folder. Shared, both tills fire the shop's one command against their own backup and the last to finish is the copy that survives |
| `backup_folder` | A folder on this machine |
| `ui_density`, `ui_theme` | How this screen is set up. A 10-inch till at the counter and the owner's laptop want different answers |

They move across once on the first start after the upgrade, so a shop already
running keeps the printer it had. A machine that has already recorded its own
answer keeps it, which is what stops the second till to be upgraded adopting the
first one's.

**Phase 1 — the changefeed. Built (migration 021).**

One table naming what has changed here, so sync has something to ask for that is
not "diff two whole databases". Three things about it came out differently from
the sentence that used to be in this paragraph, and each is worth keeping:

- **It is written by triggers, not by the service layer.** The plan said "the
  same seam that writes the audit row". That seam is not the complete set of
  writes: `bootstrap.ts` and `seed.ts` write no audit rows at all and between
  them insert into ten of these tables. A missing feed row is not a slow sync,
  it is a row that never replicates and never reports that it did not.
- **It is a dirty set, not a log** — one row per changed record, replaced each
  time it changes. A price edited forty times before the other till asks is one
  row to send. It holds **no payload**: it names what changed and the row is read
  at send time, because a payload here would be a second copy of the truth.
- **It records no `rev`**, although that was in the plan. `bump_rev_*` and the
  feed triggers fire on the same UPDATE and SQLite does not define which runs
  first, so the rev stored here would be the pre-bump one about half the time. A
  column that is right most of the time is worse than no column, because it is
  the kind that gets trusted.

`sync_state.applying` is how a merge says "these writes are not news", without
which two tills hand one row back and forth for ever. It is set only inside the
transaction that does the merge, so no failure can leave it stuck on.

**What it covers, and what it does not.** The 21 tables carrying `rev` feed as
themselves; `stock_ledger` and `loyalty_entries` feed as themselves too, being
append-only and merging by union; the twelve line tables mark their parent, so a
bill whose lines changed travels whole. `product_stock` and `doc_sequences` are
out on purpose — derived, and taking either side of a number series would hand
two tills the same invoice number. `doc_formats` is in, and migration 022 gave it
the `rev` it was missing, so it is settled by the same rule as everything else
rather than by the two machines' clocks.

`changefeed.test.ts` derives the covered set from the schema, so a table added
later fails the run rather than being quietly left out. It caught `doc_formats`
the first time it ran.

**Migration 022 — a document's revision moves when any part of it moves, and the
merge rule.**

021 made a line table mark its parent, so a bill whose lines changed is *sent*
whole. 022 is the other half: a bill whose lines changed has *changed*, and its
`rev` now says so. The gap was clearest on the permission grid — `saveRoleMatrix`
updates the role after writing the grid, so it was fine, while `applyUpgrades`
writes the same two tables and has no reason to touch the role. A newly granted
screen therefore reached the second till as a role whose revision said nothing
had happened. That is 019's argument a third time: an invariant call sites have
to remember is not an invariant.

**The rule itself is `packages/core/src/domain/merge.ts`** — pure, so it can be
argued with and tested on its own rather than discovered inside a sync that has
already overwritten something:

1. **Higher `rev` wins.** It only rises, and it rises on every local change.
2. **Level revisions: the later `updated_at`.** Second and not first, because two
   tills' clocks are not one clock — a till an hour slow would otherwise lose
   every disagreement it was ever in.
3. **Still level: the higher device id.** Arbitrary on purpose. What matters is
   that *both tills decide the same way*; a rule that resolves differently on the
   two machines leaves them disagreeing for ever, each certain it is right.

A delete beats an edit that did not know about it, because of which mistake is
recoverable: a row wrongly kept is deleted again in a second, and a row wrongly
deleted is gone with everything attached to it. A row the far side changed *after*
the delete travelled comes back, because that is somebody deliberately reinstating
it rather than a disagreement.

**What it deliberately will not guess** is whether an edit was lost. A higher
`rev` does not prove the winner had seen the loser's change, and knowing properly
needs a version vector per row — a real cost on every table for a shop that
mostly has one till. So `contested` is answered by the one fact the transport
actually has: the row is in *both* tills' changefeeds since they last agreed,
which is a concurrent edit for certain. Guessing instead would put a warning on
the screen every time one till was merely behind, and a warning that cries wolf
is one nobody reads.

**Phase 2a — the protocol. Built (migrations 023 and 024).**

Two tills agreeing, with no network anywhere in it. `services/sync.ts` is handed
a `SyncTransport` — `hello`, `fetch`, `offer` — and everything that can be got
wrong about replication lives on this side of that line, where two real
databases are pointed at each other in a test and made to agree. The bugs that
matter here are not dropped packets. They are a row applied on one till and not
the other, a cursor moved before the batch arrived, an edit overwritten in
silence. None of those needs a socket to happen, and none needs one to be caught.

One round is pull, apply, push, then move the cursors — pull first, so a batch
we send is built from a database that has just taken in everything the other
side had. A peer's cursor moves **only when that peer confirms it**, never
because we posted something: a batch that left and never landed has to be sent
again, and a cursor moved on hope is a row lost with nothing recording that it
went missing.

**A shop identity, which the tests produced rather than the plan.** Pointing two
tills at each other failed on `UNIQUE constraint failed: roles.name`, halfway
through a batch. Not the merge rule's fault — both databases had been
*bootstrapped separately*, so each had minted its own Admin role, its own
counter, its own price list: same names, different ids. Every natural key in the
schema collides that way, and there is no merge rule for it, because the two
rows are not two versions of one thing. They are two different things with one
name.

This document had already answered it without noticing it was a question. One
database per shop means a second till **joins** a shop; it does not create one
and then reconcile. So a till that has been set up carries a `shop_id` and one
that has only been migrated does not — and the handshake refuses two different
shops before a row moves, while letting a till with no shop of its own join
anybody. A new till is migrated, left empty, and filled by its first sync.

**`domain/replicaShape.ts`** is the one list of what replicates and in what
shape, because that list had reached four copies — 021's triggers, 022's
triggers, the sender and the receiver. `replicaShape.test.ts` checks it against
the triggers actually in the database, both ways, so a table in one and not the
other fails the run. It caught a `schema_migrations` table that has never
existed; migrations are tracked in `PRAGMA user_version`.

**Phase 2b — transport.** The host advertises itself on the LAN; a till pairs
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
