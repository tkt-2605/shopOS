# Sync, measured against practice other people paid for

Written 18 September 2026, after a review of the till-sync seam against the
systems that have shipped this shape before. The review found the skeleton
right and the failure handling absent, and this is the argument for each change
rather than a list of them.

Nothing here is invention. Every item names the practice, who established it,
and what it cost them to learn it. Where ShopOS should deliberately *not* follow
the practice, that is argued at the end rather than left silent.

---

## What is already standard, and should be left alone

Worth writing down first, because the rest of this file is a list of faults and
that is not a fair picture on its own.

- **Trigger-based change capture.** cr-sqlite and PowerSync both build their
  upload queue from SQLite triggers for the reason 021 gives: a service-layer
  seam is not the complete set of writes. This was got right first time.
- **A cursor per peer, advanced only on the peer's acknowledgement.** Postgres
  replication slots, Kafka consumer offsets. `sync.ts` states the rule — "their
  word, not our hope" — in the same words Kafka's documentation uses.
- **Append-only ledgers merged by union, with the cache as a fold over them.**
  This is a G-Set with a derived view, correct by construction. It is the
  best-designed part of the seam and needs nothing.
- **A per-node prefix on the number series.** Snowflake's worker id; ERPNext's
  naming series per POS profile. 037 arrived at the same answer.
- **Schema compatibility as a floor rather than an equality.** Avro and
  Protobuf call this BACKWARD compatibility; Kafka's Schema Registry enforces
  it. `MIN_PEER_SCHEMA_VERSION` with an additive/breaking classification per
  migration is exactly that, and is better than most in-house systems manage.
- **Signed requests with a nonce and a bounded timestamp window.** The AWS
  SigV4 construction. `syncAuth.ts` has it right down to the constant-time
  compare.
- **Exponential backoff with a cap, and refusals excluded from it.** Standard,
  and the distinction between an answer and a silence is one many systems never
  make.

---

## 1. A record that cannot land must not stop the ones behind it

**The practice.** Every log-shipping replicator ends up with a skip valve and a
dead-letter path, and every one of them added it after an outage rather than
before. Kafka Connect has `errors.tolerance` and a dead-letter queue. Postgres
15 added `disable_on_error` and `ALTER SUBSCRIPTION ... SKIP (lsn = ...)`
because a single constraint violation on a subscriber would stall apply for
ever and retry identically. MySQL has carried `replica_skip_errors` and
`sql_replica_skip_counter` for two decades.

**What ShopOS does.** `mergeBatch` applies the whole batch in one transaction
with no per-record boundary. A record that violates any constraint throws,
`applyingRemote` rolls back, `their_cursor` never moves, and the next round
builds the identical batch and dies identically — for ever, at 45-second
intervals, reporting a network error. Proven by `syncReview.test.ts`.

**The change.**

- A `SAVEPOINT` per record inside the batch transaction. The batch staying one
  transaction is right for the reason the comment gives — half a merge is not a
  state any rule describes — and a savepoint keeps that while letting one
  record fail alone.
- A `sync_quarantine` table: the record as it arrived, the peer, the SQLite
  error and its constraint, and the time. Bounded, and pruned like the conflict
  log rather than kept for ever.
- The cursor advances past a quarantined record. A record that will never apply
  must not hold the cursor, or the skip valve has not been built.
- A screen. `sync_conflicts` already has one; this is the same shape and more
  urgent, because a quarantined record is data the other till has and this one
  does not.

Migration 038, additive.

---

## 2. Secondary uniqueness has no place in a multi-master schema

**The practice.** CouchDB has no unique constraint except `_id`, deliberately.
Firestore the same. Galera and Postgres BDR both document multi-master unique
violations as something the application must design out, not something the
replicator resolves. The reason is arithmetic rather than taste: uniqueness is
mutual exclusion, and mutual exclusion cannot be decided by two partitioned
nodes.

Where a natural key genuinely must be unique, the proven answer is to derive
the primary key from it — name-based UUIDs, RFC 9562 version 5 — so that two
nodes creating the same real-world thing create the same row rather than two
rows that cannot coexist.

**What ShopOS does.** Twenty-two constraints on replicated tables are unique on
something other than the primary key, inherited from a schema written when
there was one till. Two counters pricing one item, or scanning one barcode,
wedge the shop under item 1.

**The change.** Mint the id from the thing for every table whose uniqueness is
a natural key:

| Table | Id derived from |
|---|---|
| `categories` | normalised name |
| `price_lists` | normalised name |
| `product_barcodes` | the barcode |
| `item_prices` | product + list + unit + min_qty |
| `customer_item_prices` | customer + product + unit + min_qty |
| `product_units` | product + sale unit |

Two tills then write the same row and the existing LWW merge settles it, with
no new machinery. For `product_barcodes` this is also the correct semantics: a
barcode belongs to one product, and a till moving it is an edit to one row
rather than two rows fighting.

The honest edge: after a rename, the id no longer matches the name, so a third
till creating the old name collides with the renamed row's id. That is a
genuine LWW merge of two things a person would also confuse, and it is the
right failure. It is written down rather than designed away.

Three constraints are not natural keys and stay as they are:

- `users.username` — created rarely, by an administrator, and a collision is a
  real one. Prevented at the screen.
- `registers.prefix` — two counters sharing a prefix is the collision the whole
  seam exists to prevent. Stays hard, and the screen should show which prefixes
  are taken the way it already shows which counters are claimed.
- `bills.doc_no` and the other five `doc_no` columns — already partitioned by
  register prefix, which is item 1's answer done properly.

Migration 039, breaking: existing rows have minted ids and the whole shop must
be renumbered in one step, so tills either side of it cannot sync. Nothing is
released, so no shim.

---

## 3. Stop hard-deleting replicated rows

**The practice.** CouchDB keeps a deleted revision. Cassandra writes a tombstone
carrying a timestamp and keeps it for `gc_grace_seconds`. Both exist because a
delete with no version cannot be ordered against a concurrent edit.

**What ShopOS does.** `collectChanges` emits `row: null` for a delete, so
`decideDeletion`'s `deletedRev` is always null and its `keep` branch is
unreachable. `merge.ts` documents the rule at length; the wire cannot carry it.

**The change.** 021 already says the right thing — "a soft delete sets
`deleted_at`, which is an UPDATE, and travels as one". Make that the only kind
of delete a replicated table has. Hard delete stays for tables that never
travel. `decideDeletion` and its paragraph then go, because a soft delete is an
ordinary LWW field and needs no second rule.

Migration 040, additive where a `deleted_at` is missing.

---

## 4. A merge must never raise the version of what it applied

**The practice.** Any LWW scheme with a version counter has exactly three
obligations: the version rises only on a local write, the merge never touches
it, and dropped writes are recorded. ShopOS has the first and third.

**What ShopOS does.** The `bump_rev_*` triggers from 019 carry no
`sync_state.applying` guard, although 022 states the invariant out loud. On a
concurrent edit the receiving till ends one revision above the machine that
wrote the row, and the two disagree about the version of an identical row for
ever after — which pushes the next genuine edit down to the timestamp
comparison, on the clocks `rev` exists to distrust.

**The change.** Add the guard to all twenty-two triggers. Migration 041,
additive.

---

## 5. Timeouts must grow outward

**The practice.** The standard deadline hierarchy: the work budget is the
innermost number, the server's wait is larger, the client's is larger again.
Inverting it produces a request that is abandoned while the work it asked for
is still running and still committing.

**What ShopOS does.** `MERGE_BUDGET_MS` is 90 seconds and `ANSWER_TIMEOUT` is
60. A merge that uses its budget has already been answered `503 NOT_READY`.

**The change.** `ANSWER_TIMEOUT` above `MERGE_BUDGET_MS` with headroom, and a
test asserting the ordering so it cannot invert again. The two constants live
in different languages, so the test has to read the Rust source — which is the
shape `joiningIsNotSettingUp.test.ts` already uses.

---

## 6. One writer, waiting, not refusing

**The practice.** SQLite's own: WAL, one write connection, `busy_timeout`, and
readers that do not block. ShopOS sets all four pragmas.

**What ShopOS does.** An application-level check in `Db::begin` refuses a second
transaction outright before SQLite's `busy_timeout` can do anything about it,
and nothing serializes the answering side against the sync loop —
`syncHost.answer` is fired per request with no lock, and the loop's `running`
flag covers outbound rounds only. Two tills nudging on the same bill therefore
trade 500s on a shop where nothing is wrong, and a cashier submitting a bill
during a merge gets a hard refusal rather than a wait.

**The change.** One asynchronous mutex in the webview that both directions
take, with a bounded wait and a queue. The refusal stays underneath it as the
backstop it was meant to be.

Separately: reads should stop joining the write transaction. WAL gives
concurrent readers for free on a second connection, and the current arrangement
is documented as "the right answer by accident".

---

## 7. Every replica reports how far behind it is

**The practice.** `Seconds_Behind_Source` in MySQL, `replay_lag` in
`pg_stat_replication`, consumer lag in Kafka. Not one of these systems asks an
operator to infer it.

**What ShopOS does.** `/hello` returns `yourCursorWithThem` and not the
sender's `feedHead()`, so a till can compute what it still owes and can never
compute what it is still owed. `PeerHealth.waiting` says so explicitly.

**The change.** Put `head` in `PeerHello`. `waiting` gains a second number.
`syncStatus` gains the sentence that matters — *the back counter has 95 bills
this till has not seen*.

---

## 8. A total must state what it is a total of

**The practice.** Accounting calls an unclosed period provisional. Warehousing
calls it a watermark. Either way the rule is that a figure assembled from a
replica says as of when.

**What ShopOS does.** `syncStatus` renders in `SyncCard` alone. Reports, the
Dashboard and the cash-counter close print a number that silently means "what
this machine happens to know about". On the evening the back counter was off
since four o'clock, the day's takings are short and nothing says so — and
GSTR-1 is filed off the tax tab.

**The change.** With item 7 in place, any screen that totals across the shop
carries a line: complete, or short by a named till since a named time. This is
the item with the largest consequence outside the code and the smallest amount
of code in it.

---

## 9. Mutual exclusion is a lease, with a way to break it

**The practice.** Chubby and ZooKeeper hand out leases with expiry, not locks
without one, and the fencing-token literature exists because a lock held by a
machine that has gone away is the failure that matters. Every clustered system
also has a membership command: a node can be removed.

**What ShopOS does.** `registers.claimed_by` is a lock with no expiry and no
release. There is no way to forget a peer anywhere in the codebase. A restored
backup carries a claim by a device id that no longer exists — `device.json` is
deliberately not in the backup — so the restored till cannot bill and cannot
take its own counter back, and the only escape changes the invoice series for a
physical counter mid-year.

**The change.**

- `claimed_by` gains `claimed_at`, refreshed each time the till starts. A claim
  nobody has renewed in a configurable span can be taken with a warning naming
  the till and the date.
- A "this till is gone" action: deletes the peer row and clears its claims. It
  is membership management, and every system of this kind has it.
- The restore path checks for claims by device ids no peer holds and offers to
  clear them, because that is the moment the shopkeeper is already being asked
  questions.

Migration 042, additive.

---

## 10. Never trust a peer's offset beyond what was sent

**The practice.** A broker validates the offset a consumer commits. ShopOS
already applies the discipline in one direction — `handleFetch` refuses to move
a cursor backwards — and not in the other.

**The change.** `Math.min(ack.upTo, outgoing.upTo)`, and `sent` counted from
what was acknowledged rather than from what was posted.

---

## 11. Discovery: mDNS, not a hand-rolled broadcast

**The practice.** RFC 6762 and 6763. Bonjour, Avahi, and mDNS built into
Windows since 10. Syncthing, Chromecast, every network printer. A responder
enumerates interfaces, answers on the one a query arrived on, and handles the
multi-homed case that `pairing-rethink.md` finding 7 ran into on a laptop with
a WSL adapter.

**What ShopOS does.** A UDP broadcast from a socket bound to `0.0.0.0`, and
`lan_address()` guessing which interface is the shop's by asking which way
`192.168.1.1` lies.

**The change.** A crate, which is a dependency this project has been right to
resist elsewhere and is the wrong place to resist it: the alternative is
writing an interface enumerator. Stage 5 of `pairing-rethink.md` left this
open on the grounds that discovery only has to be pleasant when it works — that
reasoning holds, and it is also the reason this is item 11 and not item 2.

---

## 12. Clock skew: keep the window, surface the failure

**The practice.** A bounded skew window on a signed request is the standard
construction and five minutes is a normal value. The practice that goes with it
is that clock skew is monitored and alarmed — etcd, Ceph and Kafka all do —
because a node whose clock has drifted fails in a way nobody diagnoses from the
symptom.

**What ShopOS does.** `CLOCK_TOLERANCE_MS` is five minutes, which is right.
`merge.ts` is designed around an hour of skew, which it can therefore never
meet. `STALE` has no sentence in `REFUSALS`, so the screen says "The other till
refused: STALE." — which is finding 3 of `pairing-rethink.md`, verbatim.

**The change.** Keep the window. `/hello` already carries a timestamp in the
signature; compare it and warn well before the refusal, with a sentence naming
the clock and the two times. Add `STALE`, `SERVER_ERROR` and `REPLAYED` to
`REFUSALS`.

---

## 13. An automatic retry may not bypass a backoff

`nudgeSync` calls `runOnce(db, true)`, and `force` skips the quiet window. So
every bill rung up at the front counter opens a five-second connect attempt at
a back counter that has been off since four, serially, before the live peers
are reached. A person pressing "catch up now" may bypass a backoff; a write may
not. One argument to split.

---

## Order, and what each costs

| | Item | Why here | Size |
|---|---|---|---|
| 1 | Quarantine and skip (1) | the only fault that ends with a shop silently not replicating | 2 days |
| 2 | Derived ids (2) | removes most of item 1's causes rather than catching them | 2 days + migration |
| 3 | Membership and leases (9) | the recovery path has no exit today | 1 day |
| 4 | Lag and watermark (7, 8) | largest consequence outside the code, smallest inside it | 1 day |
| 5 | Timeouts and the write mutex (5, 6) | one question about who holds the connection | 1 day |
| 6 | Trigger guard, soft delete, ack clamp, backoff, words (3, 4, 10, 12, 13) | each small and independent, each with a test already written | 1 day |
| 7 | mDNS (11) | genuinely optional, genuinely a dependency | 2 days |

`syncReview.test.ts` already fails on 1, 3, 4, 7's cause, 10 and the early-stop
bug in `syncUntilDone`. It is the acceptance test for items 1, 2, 3, 4 and 10
and should go green rather than be deleted.

---

## What is deliberately not adopted

**Version vectors per row.** Syncthing and Automerge carry them and they are
the correct answer to "did the winner see the loser's edit". `merge.ts` already
argues the cost — a vector per row on every table, for a shop that mostly has
one till — and the argument is sound. Recording a contested edit rather than
resolving it is the honest half-measure, and it stays.

**TLS between tills.** This is the one place where the standard practice is
clearly better than what is here and is being declined anyway, so the reason
should be on the record. Syncthing solved exactly the objection `syncAuth.ts`
raises — "certificates nobody can check, pinned by hand, expiring in a shop
with no IT" — by making the device id *be* the certificate's fingerprint,
exchanged at pairing, with no CA and nothing to expire. The pairing handshake
in this product is precisely where that exchange would happen, so the cost is
lower than the comment assumes.

It is still not next. The threat is somebody already on the shop's wifi, the
Settings screen says out loud that bills cross in clear, and every item above
is a shop losing data rather than a shop being read. Revisit after item 7.

**A store controller, or an authoritative cloud.** The industry-standard shape
— IBM 4690, Oracle Micros, LS Retail — is a back-office box that arbitrates,
and `phase-6-spec.md` deliberately makes the cloud a read-only replica instead.
That is the right call for a product whose first rule is that the counter works
with the line down, and it is the reason items 2 and 9 exist: without an
arbiter, every piece of state has to be either owned by one till or
commutative, and the faults above are all state that is neither.
