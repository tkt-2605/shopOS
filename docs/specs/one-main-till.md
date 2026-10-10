# One main till

Decided 10 October 2026. Built on the branch `one-main-till`, in stages that
each merge back when green. Nothing here changes how a record merges; it
changes who talks to whom.

## As built (10 October 2026)

Stages 0–4 and 6 are built on `one-main-till`; 5 was overtaken; 7 waits for
the Phase 6 cloud peer. Where the build differs from the plan below, the build
is right and the reason is here.

- **Who dials whom needed no new rule.** A till that does not listen never
  advertises a port, so the main holds no address for it and dials nobody,
  and `pairedPeers` was already correct. A till asks the main every 15 seconds
  instead of 45, because it is now the only side that starts a round.
- **There is no `STALE_MAIN` refusal.** Every till holds the whole books and
  merges both ways, so trading rows with an old main is never wrong, and
  refusing it would strand whatever that main took while it believed it was
  the main. What stops two mains is the epoch: the hello carries it both ways
  (the asking till puts its own in the body), the lower side steps down at
  first contact, and a tie goes to the lower device id.
- **A planned handover does not introduce the new main to every till.**
  Pairing keys are made fresh for each pairing, so the old main has no key of
  the new one's to vouch for. Instead the old main keeps answering the tills
  that still dial it (`listens`), relaying between them and the new main, and
  each till is paired with the new main through the ordinary Allow prompt when
  convenient. Nothing waits on the order things happen in.
- **The firewall rule is not added.** The installer is per-user
  (`installMode: currentUser`), and a firewall rule needs an administrator.
  Changing the install mode moves where every shop's app lives, which is the
  owner's call, not this branch's.
- **Stage 5 is not needed.** 0.2.16 made every till create its own counter,
  with a prefix computed from its device id, so there is nothing for the main
  to hand out.
- **Joining by copy keeps the till's identity** rather than taking a new one as
  a restore does, and carries every table that is the till's own across
  (`sql/carry-over-after-copy.sql`). A till that has written something the
  main has not received is refused a copy. A main too old for `/copy` seeds as
  it always did, so the till falls back to the feed.
- **Stage 6: extra tills keep syncing.** See `licensing-and-accounts.md`, *As
  built*.
- **Tills paired before this** stay equal until somebody chooses a main, and
  the bench keeps its tills equal (`keepTillsEqual`) because it proves
  convergence over any graph.

## Why

Until now every till has been the equal of every other: any till may answer,
pair, relay and sync with any other, and each pair carries its own secret,
cursors and failure modes. `pairing-rethink.md` records what that cost the
first evening two real copies met. Seven problems in one evening, and most of
them came from the equality rather than from separate bugs:

- every machine had to listen, so every machine met the firewall;
- nothing said which machine should answer and which should join;
- a second till was handed the first one's counter.

It also produced the scale problem. Pairing seeds the whole shop into the feed
(`seedFeedWithEverything`), so two big tills meeting move the whole shop
through 200-record batches.

Products this shop owner will have used (Tally, most POS systems) have one
place every till syncs through. So does ShopOS from here on. Every till still
holds the whole books and bills offline. Only the *exchange* goes through the
main.

## Who is the main

| The shop's plan | The main | The other tills |
|---|---|---|
| Free | the one till | none |
| Business (bought once) | a local main till on the LAN | bill; sync through the local main |
| Cloud (monthly, while paid) | the cloud peer | bill; sync through the cloud |
| Cloud ends, shop has Business | handed to the home till | keep billing over the LAN |
| Cloud ends, no Business | handed to the home till | view only, after they have handed over |

The main always bills. "A licence never stops *the shop* billing" is unchanged
and stays asserted. What a lapse takes away is the *other* tills starting money
documents. That is the rule already decided on 27 Sep in
`licensing-and-accounts.md` (*When paid time ends*), and this spec is where it
gets built.

**Which machine should be the main** (owner's guidance, 10 October): with
two or three tills, the counter that is on whenever the shop is open. With
four or more, a dedicated always-on PC that nobody bills on -- a main till in
every respect, set up as the shop and joined by the counters -- or the cloud.
A shop of four counters where none is reliably on is the one case where every
till being equal did better, and that is the answer to it rather than going
back to it.

**The home till** is the local till that takes the main back when Cloud ends.
The owner picks it when subscribing; by default it is the till that was the
local main, otherwise the first till. Nobody has to choose on the bad day.

## What does not change

- **The protocol:** `syncWith`, `/hello`, `/fetch`, `/offer`, the change feed,
  merge, conflicts, quarantine and the ledger. A main till is a shop where
  every till pairs with one till. One pair is the case the protocol has always
  handled, and a hub relaying between spokes is already tested
  (`aHubInTheMiddle.test.ts`). The origin filtering from 036 is what makes the
  main a relay, so it stays.
- **Offline-first:** every till bills with the main switched off, the line
  down, or no internet.

## The layout module

Today the answers to "who does this till talk to" are spread across
`apps/pos/src/core/syncLoop.ts` (who to dial), `syncHost.ts` and
`src-tauri/src/sync_server.rs` (whether to listen) and
`services/syncServer/pairing.ts` (who may join). They move behind one module,
`packages/core/src/services/sync/layout.ts`, which answers five questions and
nothing else:

- `role(db)`: one of `'alone' | 'main' | 'till'`.
- `listens(role)`: only the main.
- `dials(db)`: the main, for a till; nobody, for the main or a till alone.
- `mayPair(db, asker)`: the main accepts tills; a till accepts nobody.
- `mayStartMoneyDocs(db, licence)`: true for the main and for a till alone;
  for other tills, true while the shop holds `multiTill` or `cloudPeer`, and
  false after the handover once it does not.

The cloud being the main is a different answer from the same module, not a
second mechanism.

## The main-till number

Whoever is the main is recorded as a pair: the main's device id and an
**epoch**, a number raised by one at every change of main. This is Raft's
term, Kafka's controller epoch, and the timeline Postgres raises on promotion.

- **Storage:** two columns on `sync_state` (`main_device`, `main_epoch`). The
  migration is additive, comes with its `migrations.ts` entry and
  `EXPECTED_SCHEMA_VERSION` raise, its `migrationKinds.ts` classification and
  the hand edit to `schema.ts`. Not in `settings`: `settings` replicates, and
  a last-writer-wins merge has no idea that a lower epoch must lose.
- **On the wire:** `/hello` carries both, in both directions, as optional
  fields. An older build ignores them.
- **The rules:**
  - A till adopts any higher epoch it is told about, and the main that goes
    with it.
  - A main that hears a higher epoch steps down to `till` and dials the new
    main.
  - A till refuses to sync with a peer claiming to be the main at a *lower*
    epoch, with `STALE_MAIN`, and says which till it believes is the main.

  Together these make two mains impossible rather than unlikely: the old main
  coming back after a repair is demoted on first contact.

## Changing the main

Every change of main is a person's decision or a plan event. Nothing ever
switches automatically. Safe automatic failover needs three voters, and a
two-till shop has two. That is why two-node systems everywhere either add a
witness or switch by hand.

### Planned: the old main is alive
Used when moving the main to a new PC, and when Cloud starts or ends.

1. The old main finishes syncing with every till it can reach.
2. It writes the new main and `epoch + 1`.
3. It introduces the new main to each till. It already shares a secret with
   each one, so it can vouch, and nobody types a code.
4. It becomes a till.

Nothing is lost, because the old main was up to date before it let go.

- **Cloud starts:** the local main is the old main and the cloud peer is the
  new one. The cloud takes a copy of the local main's database (see *Joining*).
- **Cloud ends:** the cloud is the old main and the home till is the new one.
  - The cloud keeps answering for a **grace period** after expiry, so that
    every till can hand over its last bills. This matches the 90-day read-only
    replica in `phase-6-spec.md`.
  - The cloud accepts syncs but holds the main role only until the handover
    completes.
  - A till goes view-only only *after* it has handed over. One that was
    switched off on expiry day loses nothing.

### Unplanned: the old main is dead
For a Business shop whose main PC dies.

1. Someone with the owner's permission presses "Make this the main till" on
   the most up-to-date till. The screen says what will happen. Permission is
   checked in the service with `requirePermission`, as everywhere.
2. That till writes itself as the main at `epoch + 1`.
3. Each other till is paired with it using one code, because the secrets they
   held were shared with the dead main.
4. **One full comparison per till:** after a promotion, each till and the new
   main each run `seedFeedWithEverything` once for that peer. A till may have
   sent bills to the dead main that never reached the new one, and may have
   pruned them from its feed since. A full exchange merges both ways and never
   discards. It is slow, but it happens only after a main dies.

Whatever only the dead main held is gone unless its disk is recovered. That is
true of every design and is what the backup is for.

## Joining

A till joins by pairing with the main and nobody else.

- **A new till takes a copy of the main's database.** It does not get the
  shop through the feed.
  - The main takes `VACUUM INTO`, as `backup_write_zip` does, and records its
    feed head in the same read.
  - Rust carries the file over the signed connection, in chunks, resumable and
    checked against a sha256.
  - It is installed through the restore path (`restore.rs`: staging, marker,
    restart, safety copy).
- **After the install:** the copied `change_feed` is cleared, and the new
  till's cursor on the main starts at the recorded head. Pairing with `holds`
  skips `seedFeedWithEverything`, so the first round moves only what changed
  after the copy.
- **The main hands out the counter at join:** the first free one, or the one
  this till held before. Two tills on one counter stops being possible, rather
  than merely refused afterwards.
- **A till that already has data** (a restore, a reinstall) goes through
  `unsentIn`. If it holds changes the main lacks, it syncs them first, and only
  then takes the copy.

## The firewall

Only the main listens, so only the main needs an inbound rule. The NSIS
installer (`tauri.conf.json`, `bundle.windows.nsis`) adds a rule for the app's
executable on every install, because the installer cannot know the role. A
rule on a till that never binds a port opens nothing.

## Stages

Each stage is a short branch off `one-main-till`, merged back when
`npm test` and `npm run typecheck` pass. `one-main-till` takes
`phase-2-foundations` every couple of days, so it never drifts far.

| # | Stage | Main files | Rough size |
|---|---|---|---|
| 0 | Layout module, behaviour unchanged: today's rules behind it | `sync/layout.ts`, `syncLoop.ts`, `syncHost.ts`, `pairing.ts` | half a day |
| 1 | Local main: only the main listens, tills dial and pair with the main only; firewall rule | `layout.ts`, `sync_server.rs`, `SyncCard.tsx`, NSIS hook | 1–2 days |
| 2 | Epoch: migration, `/hello` fields, step-down, `STALE_MAIN` | migration, `schema.ts`, `round.ts`, `handlers.ts` | 1 day |
| 3 | Changing the main: planned handover, promote button, one full comparison | `layout.ts`, `pairing.ts`, Settings | 2 days |
| 4 | Join by copy: transfer, install, cursor at head, no seed with `holds` | `sync_server.rs`, `sync_client.rs`, `restore.rs`, `restored.ts`, `pairing.ts` | 3–4 days |
| 5 | Counter handed out at join | `pairing.ts`, `registers.ts` | 1 day |
| 6 | View-only after handover when the shop holds neither `multiTill` nor `cloudPeer` | `layout.ts`, billing guards, `multiTillGate.test.ts` | 1 day |
| 7 | Cloud as the main: subscribe and expiry handovers, home till, grace | needs the Phase 6 cloud peer | after Phase 6 |

Stages 0–6 need nothing that does not exist. Stage 7 waits for the cloud peer
in `phase-6-spec.md`, which already describes it as a device that never
initiates and that tills dial: exactly a main. So nothing here has to be
redone when it arrives.

## Tests that must pass before each merge

- **Stage 0:** the whole existing suite, unchanged. It is a move, not a change.
- **Stage 1:**
  - Three tills, one main: every till converges through the main, with writes
    on every till while apart.
  - A till refuses a pairing from another till.
  - The main listens; tills do not.
- **Stage 2:**
  - Two tills both claiming to be the main at epochs 3 and 4: the 3 steps
    down on first contact.
  - A till refuses a main at a lower epoch than it knows.
  - A peer with no epoch, an older build, still syncs.
- **Stage 3:**
  - A planned handover with bills in flight loses none.
  - Promotion after the main dies: bills a till sent only to the dead main are
    merged back from that till's side, and the books converge.
- **Stage 4:**
  - A new till joining a shop of a million rows sends and receives only what
    changed after the copy. Asserted by row counts on the bench, not by time.
  - A power cut at each install step leaves the old database or the new one.
  - A join refused while the till holds changes the main lacks.
- **Stage 5:** two tills joining in the same minute get different counters.
- **Stage 6:**
  - With the licence lapsed and the till handed over, the till cannot start a
    bill but can read everything.
  - The main still bills (the first rule, unchanged).
  - A till that has *not* handed over still bills.

## What gets simpler, and what is deleted

- **Pairing between two non-main tills:** refused, and its screen goes.
- **Discovery:** kept, but it looks for the main only; a till never answers
  it.
- **"Start answering":** gone. A main listens; a till does not.
- **Re-seeding on every pairing:** gone. It stays only for the one full
  comparison after a promotion.
- **The sync screen:** one line, "In step with the main till ✓", or what is
  not and what to do.
