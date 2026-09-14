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

## What is already right

This was designed for it. `001_initial.sql` says so in its own header, and the
schema keeps the promise:

| Already true | Why it matters when there are two tills |
|---|---|
| Every id is a **UUIDv7** | Two tills billing at the same second cannot mint the same key. This is the single hardest thing to retrofit and it was never a problem here |
| **Document numbers are per register**, per fiscal year (`nextDocNo`) | `FC/26-27/00012` and `TILL2/26-27/00003` cannot collide, even with no network between them |
| Ledgers are **append-only**; nothing is updated after submit, correction is cancel + amend | Facts merge by union. There is no "which version of this bill is right" question to answer, because a bill is never edited |
| `rev`, `origin_id`, `deleted_at` on every mutable table | The columns a replicator needs, written since day one and read by nothing |
| `SqlDriver` is an interface with two implementations already (`node-driver`, `tauri-driver`) | A third that talks to another machine is a seam that exists, not one that has to be cut |
| `stock_policy` is a shop-level choice of block / warn / allow | The hardest merge conflict — two tills selling the last one — already has a policy switch and an answer the shop chose |
| `EXPECTED_SCHEMA_VERSION` and `staleBuild()` | Two tills on different builds is the sync bug that corrupts data. The guard for it is already written |

## What is wrong today

- **`setDeviceRegister` writes to `settings`** (`services/registers.ts:144`),
  which is a shared table. Two tills sharing a database would both claim the
  same counter and then overwrite each other. It is one row and it is the first
  thing to move.
- **There is no device identity.** `origin_id` is a column with nothing to put
  in it. Until a device knows its own name, no change can be attributed and no
  replication can decide anything.
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

**Phase 0 — device identity.** A `device_id` minted on first run and kept
outside the shared database, `origin_id` stamped on every write through the
`writeAudit` seam that already touches all of them, and `DEVICE_REGISTER` moved
off `settings`. Cheap, invisible, and **it cannot be retrofitted**: history
written before it exists can never be attributed. Worth doing on its own, in
the next round, whatever is decided about the rest.

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
