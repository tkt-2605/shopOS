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

**Phase 2b — the wire. Built (migration 025), except the listener.**

`syncServer.ts` is the side that answers and is deliberately **not a server**: it
takes a request that has already arrived and returns what to send back. So the
thing that listens on a port is a pipe with no opinions, the protocol has exactly
one implementation, and all of it is testable over real sockets without building
the app. `syncClient.ts` is the side that asks, and it is plain `fetch` — making
a request out is something a webview can do; listening is the only part that
needs Rust.

**Pairing is a code read off one screen and typed into the other.** Not
trust-on-first-use, and the reason is that a shop's wifi is not a trusted
network: the customer wifi is usually the same subnet and the password is on a
card by the till. Anything that could reach the port would otherwise pull down
every customer, every price and every sale. The code is eight characters, lives
ten minutes, and **any attempt spends it, right or wrong** — which is what makes
eight characters enough, because guessing becomes a matter of persuading a person
to read out a fresh code each time.

After pairing the two tills share a secret that **never travels again**. Every
request carries an HMAC over its own path, timestamp, nonce and body, so a
request cannot be altered on the way, cannot be replayed, and cannot be reused
against a different endpoint.

**What this does not do is hide anything.** The bills cross the LAN in clear.
That is written down rather than implied away, because the gap between "signed"
and "private" is exactly the kind a reader assumes closed. TLS between two tills
means certificates nobody can check, pinned by hand, expiring in a shop with no
IT — the right next step, and not this one.

`/offer` is idempotent, which it has to be: a batch that was applied and
acknowledged, whose acknowledgement was lost on the way back, arrives again.
Applying it twice is the same as applying it once, because every record is
decided against what is already there and an identical copy loses the tiebreak
and writes nothing.

Checked over the shop's own Wi-Fi, not only loopback: two tills on a real
interface, paired with a typed code, eleven records across, the product on the
second till.

**Phase 2c — the listener, and a screen. Built.**

`src-tauri/src/sync_server.rs` holds the port open and knows nothing about
replication: it accepts a request, hands the bytes to the webview, waits for an
answer, and writes it back. A second implementation of the protocol in Rust
would drift from the TypeScript one, and the drift would show as two tills that
agree about everything except the row that matters.

**Nothing listens until a shop turns it on.** A single-till shop never opens a
port, which is most shops — a port nothing uses is a way in and no use to
anybody. The parser accepts POST, a `content-length`, and one of four paths;
anything else is refused without ever reaching the webview, so a scanner
sweeping the shop's network learns only that something is there.

A webview that never answers (closed, asleep, or inside a long transaction)
returns 503 after a minute rather than holding the connection: the other till is
told to come back.

`syncUntilDone` is the loop that was owed. One round carries at most 200 records,
and a till switched off for a fortnight has thousands waiting, so `more` was a
flag nobody acted on. It is bounded, and a round that achieves nothing stops it
rather than spinning — two tills passing one row back and forth would otherwise
loop for ever, each doing real work.

The screen is `ui/SyncCard.tsx`, in Settings, and it is two halves on purpose:
the till that has the shop **shows a code**, the new till **types one in**.
Confusing those is how somebody pairs a till with itself. It says plainly that
bills cross the network unencrypted, and when a sync drops somebody's edit it
lists what was dropped rather than saying "done".

**Three bugs that only a real shop's database could find.** The protocol was
tested over real sockets and the listener had sixty tests, and pointing a second
till at the actual app still broke immediately:

1. **A batch was applied in feed order, which is not dependency order.** A
   `users` row landing before its `roles` row failed on a foreign key, and since
   the batch is one transaction, one such row failed the whole sync — the same
   way, every time. `REPLICATED` is now in dependency order, checked against the
   schema's own foreign keys by `replicaShape.test.ts`, and `applyBatch` turns on
   `defer_foreign_keys` for the one genuine cycle (`loyalty_redemptions` points
   at `loyalty_entries`, which points back at `bills`).

   Worse than the bug: `sync.test.ts` had *accommodated* it. It synced twice with
   a comment saying the register and the user "have to land first". The symptom
   was seen, worked around, and called a test. It syncs once now.

2. **A joining till got none of the shop.** The feed holds what has *changed* and
   began empty at migration 021, so a shop a year into trading had two rows in it
   and twenty products outside it. Pairing worked, syncing worked, nothing
   arrived. `seedFeedWithEverything` now puts every replicated row into the feed
   when a till pairs — in dependency order, so sequence numbers come out
   parents-first, and without touching the rows, because raising every `rev` in
   the shop would make that till look newer than every other one.

3. **The port outlived the thing answering it.** The listener is in the Rust
   process and the subscription is in the webview, and a reload ends one but not
   the other — leaving a till listening with nobody behind it, every request
   waiting the full minute for a 503, and the screen saying "Listening on
   192.168.1.11". `resumeServing` re-attaches at startup.

**Then it worked, against the real shop:** a second till paired with a typed
code over the LAN and took 189 records in one round — 20 products, 6 customers,
29 bills, 51 bill lines, the staff, the counter and the shop's own id — with
nothing contested.

**Phase 2d — finding the other till. Built.**

A shopkeeper should not have to know what 192.168.1.11 is, and the address
changes whenever the router feels like it — so typing it once turns a one-off
setup into a thing that breaks on a Tuesday for no visible reason.

`src-tauri/src/discovery.rs` answers a shout on the local network with its
label, its shop's name and id, and the port. UDP broadcast rather than mDNS: the
proper answer is a dependency, a second protocol, and a service that Windows,
routers and antivirus all have opinions about, and the question here is one
question asked across one shop's network by a handful of machines.

Three properties it is built around:

- **It answers only while the till is answering HTTP.** Same flag, same
  lifetime, so there is no state where a till announces itself and then does not
  answer when somebody knocks. A shop that has not turned sync on says nothing
  about itself to anyone.
- **It ignores anything that is not the probe**, without replying. A responder
  that answers everything can be pointed at a victim with a forged source
  address.
- **Being findable grants nothing.** It says where to knock. Pairing still needs
  a code read off that till's screen, and every request after that is signed.
  Discovery sits on top of the security and is never part of it.

What it gives away is the shop's name, an opaque id and a port — and anybody
already on the shop's wifi could find the open port with a scanner in seconds,
while the shop's name is printed on every receipt it hands out.

Checked both ways against the real app: silent with sync off; found at
`192.168.1.11:7801` by a separate process once it was on, with the noise packets
ignored; and the app's own **Find tills** button listing another till and filling
in its address.

**Phase 3 — the catch-up, and what a person sees. Built (migration 026).**

A button is honest and it is not enough. The point of two tills is that a bill
rung up at the front counter is on the back one before anybody goes looking, and
nobody presses "catch up now" every ninety seconds all day. `core/syncLoop.ts`
runs a round every 45 seconds, and it is careful about four things:

- **It backs off a till that is not there.** A counter switched off at four
  would otherwise be dialled every 45 seconds until closing. Each peer has its
  own wait, doubling to ten minutes, reset the moment it answers. A *refusal* —
  a schema mismatch — does not back off: that is fixed by updating a till, and
  until somebody does, saying so every round is the right amount of noise.
- **It never overlaps itself**, because two syncs with one peer fight over the
  same cursors.
- **It is the same code the button runs.** A "catch up now" that took its own
  path would be a second implementation to keep in step, and the one people
  press least would be the one that rots.
- **It does nothing at all until a shop has paired**, which is most shops.

Once nobody is watching, the failures that matter are the ones nothing
interrupts: the other till switched off at four and nobody notices until Friday;
two people changed one price and one of those changes is gone. So:

**`sync_conflicts` records where an edit was dropped.** Written inside the same
transaction that applies the batch, so a merge that rolls back cannot leave a
complaint about a change it did not make. It is a record and not a queue —
nothing retries it and nothing repairs it, and the only thing to be done is for
a person to look and decide whether it mattered. Acknowledged rather than
deleted: what the two tills disagreed about is worth having afterwards.

**`last_error` and `last_tried_at` on `sync_peers`** separate the two states that
look identical at a glance: a till that agreed at four and has been unreachable
since five past, and one that agreed at four and has had nothing to say since.
The screen shows *talking* or *not answering*, how long ago they last agreed, and
how much is still queued — in words (“four minutes ago”) rather than a clock
time, because a person at a counter mid-queue will not do the subtraction.

**The oversell list — two tills each selling the last one. Built.**

The one thing merging genuinely cannot fix: the goods are gone, two people
walked out with the same last unit, and no rule about revisions changes that.
What the product can do is notice, and say which item. The screen for it already
existed — "Counts that need fixing" on Stock Count — and it was never reached,
for two separate reasons:

- **`product_stock` was never recomputed after a merge.** It is a cache of the
  ledger and does not replicate; `NOT_REPLICATED` has said "a merge recomputes
  it" since the day it was written, and nothing did. So a till that took in
  another till's sales kept its old figures until somebody happened to open
  Inventory — the two tills quietly disagreed about the shelf, and *nothing ever
  went below zero*, so the list stayed empty. `applyBatch` now recomputes when
  ledger rows actually arrived, after the merge rather than inside it, so a busy
  counter is not held behind a replay of the whole ledger.
- **`balance_qty` is stamped by whichever till wrote the row**, and two tills
  that merged never shared a running total. Each sale was legitimately the last
  one at the moment it was made, so no row records going under — and the columns
  that explain a shortfall came back blank *exactly* when a second till caused
  it. When the stamped balances say nothing and the shelf is nevertheless below
  zero, the shortfall itself is what was sold short and the last sale is the day
  it happened. Inferred rather than read, and said so.

**And one more landmine, found by the test that proved it.** Two tills on the
same counter mint invoice numbers from one series, so the first bill to cross
fails on `bills.doc_no` and the sync dies on a UNIQUE constraint with nothing
saying why. That is also what a second till gets *by default* — a machine never
told which counter it is falls back to the first active one, which is the other
till's. `syncWith` now refuses with `SAME_REGISTER` before anything moves, and
the screen says which button to press.

---

Phases 0 to 3 are built. Phase 4 — branches and the phone, over the internet —
stays where this document put it: only once the LAN case has run in a real shop
for a season.

**Phase 2d — discovery.** The host advertises itself on the LAN; a till pairs
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
