# Pairing, as a shopkeeper meets it

Written 17 September 2026, after the first time two copies of the real app were
pointed at each other. Everything before this had been the bench: `packages/core`
driven from Node, over real sockets, in one process or in containers. That is a
good test of the protocol and it is not a test of the program, and this evening
is what the difference cost.

The setup is three release builds that differ only in their Tauri `identifier`,
so each keeps its own app-data folder and its own `shop.db`
(`apps/pos/src-tauri/tauri.till{1,2,3}.json`, built by `build-tills.mjs`). Three
windows, one laptop, no containers. It is worth keeping: it is the only way to
meet this software the way a shop meets it.

---

## What it found in the code

Two defects, both fixed in the same session, recorded here because of *why* they
survived until now rather than for what they were.

### The webview cannot reach another till at all

`pairWith` and `httpTransport` take the `fetch` they use as an argument, and the
app passed the webview's own. The app's CSP takes `connect-src` from
`default-src 'self'`, so every request at another till was refused before a
packet left, and the only thing the screen could say about it was the browser's
`TypeError: Failed to fetch` — which reads exactly like a till that is switched
off. It sent one person looking at their router.

**The bench could never have caught this.** Layer 1 and Layer 2 both run core in
Node, and Node has no CSP. Every sync test passed, over real sockets, proving a
protocol that the actual program could not speak. Anything true only inside the
webview is invisible to the entire test bench, and joining a shop was the first
feature to live there.

Fixed by giving Rust the asking half as well as the answering half —
`http::request`, `sync_request`, and a fetch-shaped adapter in `syncFetch.ts`.
Core is unchanged apart from a corrected comment: it had claimed that "making a
request out is something a webview can do".

### The listening port was a constant

`SyncCard` asked for 7801 and Rust insisted on it, so the second till on a
machine got `os error 10048` and the third got nothing at all. `serve_preferring`
now falls back to any free port, which every part of the protocol already
carried: the shout announces the port actually bound, pairing advertises it in a
header, and a peer is stored with address and port together. A shop whose 7801
belongs to some other program could not previously turn sync on at all.

---

## What it found in the design

This is the part worth arguing about. Each of these is something that happened,
in order, to somebody who knew how the program worked.

### 1. The two machines have roles, and nothing says which is which

One till must answer and the other must join. Both screens offer both halves,
with no indication of which machine should be which or why. Till 1's Settings
shows "Join a till that already has the shop" *while already having the shop*,
under fine print explaining that it will not work — a control that is always
visible and almost always wrong.

### 2. "Start answering" is a port, dressed as a decision

The reasoning behind the toggle is sound and is written down: a one-till shop
should never open a port, because a port nothing uses is a way in and no use to
anybody. But that is a consequence of how many tills the shop has, not a
question to put to a shopkeeper. It can simply be true whenever the shop has a
second till, and false when it does not.

### 3. Every failure speaks in network

Three failures in one evening: `TypeError: Failed to fetch`, `Could not listen on
port 7801: Only one usage of each socket address ... (os error 10048)`, and a
till found at an address that could not be reached. Not one of them tells a
shopkeeper what to do next, and the first two are not about the shop at all.

### 4. There is no single answer to "are my tills in sync?"

What the screen offers instead: `Closed. Nothing can reach this till`, `95`
under a column headed WAITING, `not answering`, and `last agreed 4 minutes ago`
— four facts, three places, and the reader still has to assemble them. The
question a shopkeeper has is one question, and it has a one-line answer.

### 5. The code is fiddly where it does not need to be

Ten minutes, one attempt, spent whether it was right or wrong. Tonight that
produced a real failure: by the time the address was corrected, the code had
lapsed, and the next attempt needed a walk back to the other machine.

### 6. A second till is handed the first one's counter, then refused for having it

The worst of them, because it is the one that damages data. `resolveDeviceRegister`
falls back to the shop's first active counter when a machine has never been
asked, so a till that has just joined silently adopts the counter the other till
is billing on. It then bills happily. Nothing objects until the next sync, which
refuses with `SAME_REGISTER`.

The comment above that refusal in `sync.ts` states the whole problem without
quite noticing:

> Refused rather than risked, and refused *before* anything moves. This is the
> one outcome the whole seam exists to prevent, it is recoverable in ten seconds
> by pressing "Use here" on the right counter, and it is exactly what a second
> till gets by default.

"Recoverable in ten seconds" holds only if it is caught before anybody bills. It
was not. Two bills were rung up, one on each till, and both are numbered
`BMR/2627/00001`. Pressing "Use here" now corrects every future bill and unmakes
neither of those, and when sync does run the first across hits `bills.doc_no`
and fails on a UNIQUE constraint — which is the exact failure the refusal exists
to prevent, arriving anyway, one step later.

**A state the program will refuse to work with is a state it should not offer.**
The guard is real and it is at the wrong end of the pipe.

### 7. Discovery answers with whichever address it likes

A till was found at `172.24.224.1:7801` while listening on `192.168.1.2:7801`.
The first is this laptop's WSL virtual adapter: `look_around` sends the global
broadcast from a socket bound to `0.0.0.0`, Windows chose that adapter to send
it on, and the reply was tagged with its address. `Found.address` is built from
the packet's source, so the list offered an address belonging to this machine
that nothing could connect to.

A developer's laptop is not a shop counter, and a real till is unlikely to have
a Hyper-V switch on it. But a machine with a wifi card and an ethernet cable has
two addresses and is entirely ordinary, and `lan_address` picks between them by
asking which way `192.168.1.1` lies — a guess that is right in most shops and is
still a guess.

---

## The shape worth trying

**Nobody types an address and nobody picks a role.**

The new till says it wants to join a shop. It finds the other one, or is told
where it is. The existing till puts up *"A new till wants to join this shop"*,
with two digits shown on both screens to compare, and somebody presses Allow.
That is the pattern people already know from pairing a phone or a speaker, it
removes the typed address, the typed code, the ten-minute window and the
one-attempt rule in a single stroke, and it moves the confirmation to the till
that is already trusted.

**The counter is chosen inside that flow and never defaulted.** The joining
till cannot bill until the shop has said which counter it sits at. See finding 6:
this is the cheapest of the changes here and it is the one that protects the
books.

**One line of status, in the shopkeeper's words.** Not four facts in three
places:

> Both tills have everything. Checked a minute ago.

> The back counter has 95 bills this one has not seen. It has been off since 4:10pm.

**No "answering" toggle.** The port opens when the shop has a second till and
closes when it does not.

### What this costs, and the part that is not settled

It leans on discovery, and finding 7 is a reason to distrust discovery on
exactly the networks that are hardest to visit. So a typed address has to
survive somewhere. The real question is whether it is the escape hatch behind a
"can't find it?" link, or whether the shape above is the escape hatch and typing
remains the main road for anyone whose network is unusual.

Worth settling before any of it is built, because it decides whether discovery
has to become reliable — enumerate every interface, broadcast on each, prefer the
one the reply arrived on — or merely has to be pleasant when it happens to work.

---

## What the prior art settles

None of this is new ground, and two of the open questions have answers that
other people paid for.

**A node must never pick its own node-ID.** The register prefix does the job
Twitter's Snowflake gives to a worker ID, and that family of systems learned the
same lesson the hard way: two workers booting with the same ID mint duplicates
silently, and nothing notices until something downstream hits a uniqueness
constraint. Which is `bills.doc_no`, one step later. Their answer is to make it
fatal — a node that cannot establish a unique identity refuses to start rather
than guessing. ERPNext, which is the reference model here anyway, does the same
thing by giving each POS profile its own naming series rather than letting
terminals share one. **Finding 6 is settled: block, do not guess.**

**Accept-on-the-other-side is the ordinary pattern.** Syncthing — offline-first,
LAN-first, bidirectional, between machines one person owns, which is this
problem exactly — has the joining device present itself and the existing device
show "this device wants to connect → Accept". Bluetooth's Secure Simple Pairing
does the same with digits shown on both screens.

**But borrow the shape, not the cryptography.** Bluetooth's digits are derived
from a key exchange, so comparing them defeats a machine in the middle and
knowing them buys an attacker nothing. That only means something over a channel
worth protecting, and this one is not: bills already cross the shop network
unencrypted, which the Settings screen says out loud. So the digits here are a
confirmation aid — *which machine am I allowing* — and not a defence. The
security model is unchanged: a network you control, and a shared secret settled
at pairing. Anything else would be ceremony implying a guarantee the transport
does not give.

**Discovery is allowed to fail.** Syncthing tries the LAN, then a discovery
service, then an address somebody typed, and any rung can carry it. A typed
address stays forever as the bottom rung. That settles question 3 in the cheap
direction: discovery does not have to become reliable across every network card,
it has to be pleasant when it works and honest when it does not.

---

## The plan

Five stages, ordered so that the one protecting the books lands first and each
is worth shipping on its own. Nothing is released — no installer, no tag, no
till anywhere fetching an update — so **none of this needs a compatibility
shim**. Old paths get replaced, not deprecated alongside.

### Stage 1 — a till never guesses its counter

The cheapest change here and the only one that protects data.

- `resolveDeviceRegister` (`services/registers.ts`) keeps the fallback to the
  first active counter **only when the shop has no sync peers** — a genuine
  one-till shop, including one upgrading from before the choice existed. With
  peers and no remembered choice it returns null, meaning *this machine has not
  been told which counter it is*.
- The billing screen treats null as a stop, not an empty string. `Billing.tsx`
  takes `registerId` from `useCore()` and hands it to `useBillTabs`; that path
  needs a blocked state that names the fix and links to Counters.
- `sync.ts`'s `SAME_REGISTER` check stays. It becomes a guard that should never
  fire rather than the thing standing between the shop and duplicate numbers.

Tests: a till with a peer and no choice resolves to null; the same till with a
choice resolves to it; a one-till shop still falls back; billing is refused
when the counter is unknown.

### Stage 2 — one line of status

No protocol change, no new data — presentation over what `syncLoop` already
knows. Replaces `Closed. Nothing can reach this till`, the WAITING column,
`not answering` and `last agreed` with a sentence: both tills have everything
and when it was checked, or what is outstanding and since when. A pure function
from the round's report to a sentence, tested as one, in the manner of
`syncWords.ts`.

### Stage 3 — the "answering" toggle goes

The port opens because the shop has a second till, not because somebody pressed
a switch. `Start answering` becomes `Add a till`, which opens the port *and*
starts listening for a join request; a shop with peers listens whenever it runs;
a shop with none and no join in progress stays closed, which is the security
property the toggle existed to protect.

Touches `SyncCard.tsx`, `syncHost.ts`, and `sync_serve_start`. The port is no
longer always 7801 (`serve_preferring`), so wherever the address is shown has to
keep showing the port — that is question 4, and the answer is that the status
line carries it, because a firewall rule needs to name something.

### Stage 4 — the join handshake

The protocol change, and the one worth building last because the three above
make it smaller.

- New path replacing `/pair` in `http::PATHS` and `handleSyncRequest`: the
  joining till posts who it is; the existing till answers `PENDING` with digits
  rather than a secret.
- The existing till holds the pending request the way `offerPairing`
  (`services/syncServer.ts`) holds a code today — in memory, with an expiry —
  and raises a prompt naming the joining machine and the digits.
- The joiner polls until `ALLOWED`, `DENIED` or the request lapses, showing the
  same digits meanwhile. Polling rather than a held connection: `ANSWER_TIMEOUT`
  is sixty seconds and a person walking to the other counter is not.
- On `ALLOWED` the secret is settled exactly as `/pair` settles it now, and the
  counter choice from stage 1 happens next, in the same flow.
- The typed code survives as the bottom rung, behind "can't find it?", for the
  network where discovery says nothing.

This deletes the ten-minute window and the one-attempt rule from the main road.
Both stay with the typed code, where they are the right mitigation — a short
typed secret is where WPS's PIN was broken, by being verifiable in halves.

### Stage 5 — discovery, only as far as it is worth

Optional by the reasoning above. The cheap part is worth doing because finding 7
is not only about virtual adapters: send the directed broadcast on **every**
non-loopback interface rather than on whichever one `lan_address` guesses, and
prefer the address a reply actually arrived from. The expensive part —
enumerating interfaces properly, which needs a crate — stays unbought until a
real shop needs it.

---

## What is still open

1. Where the join prompt appears on the existing till. A shop has one screen
   the shopkeeper is looking at and it is the billing screen, so a prompt that
   only lives in Settings is a prompt nobody sees while standing at the other
   machine.
2. Whether a joining till may be refused and what that leaves behind — a denied
   request should presumably leave no peer row on either side.
3. Whether stage 3 should let a shop close the port deliberately anyway, for the
   shopkeeper who wants two tills that only sync when asked.
