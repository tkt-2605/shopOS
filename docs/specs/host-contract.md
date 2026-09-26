# What it takes to run ShopOS's core

Written for: whoever builds the second thing that runs `@shopos/core` — the
cloud peer, a phone, a test harness, a supervisor serving several shops. It is
not a proposal. Everything here already exists and is already used by two hosts;
what was missing was anybody having said so in one place.

There is no framework to adopt and no base class to extend. Core is a library
that takes a database handle and a clock, and a host is whatever supplies them.

---

## The four things a host provides

### 1. A `SqlDriver`

Six methods, in `packages/core/src/db/driver.ts`. Everything in core goes
through this and nothing in core opens a file.

```ts
interface SqlDriver {
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]>
  get<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>
  execute(sql: string, params?: SqlValue[]): Promise<ExecResult>
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>, opts?: TxOptions): Promise<T>
  close(): Promise<void>
}
```

Two implementations exist and they are as far apart as two implementations get:
`node-driver.ts` wraps `better-sqlite3` in-process, and `tauri-driver.ts` sends
each statement over an IPC boundary to Rust. A third — a connection to a hosted
SQLite, a pool, a wrapper that logs — is the same six methods.

The only requirement that is not obvious from the types: `transaction` must be
**exclusive for the duration of `fn`**. Core opens transactions that span dozens
of statements and assumes nothing else writes inside them. Where a host cannot
guarantee that structurally, it wraps the driver — `apps/pos/src/core/writeLock.ts`
is exactly that, a FIFO gate the app puts around the Tauri driver because the
webview has two callers (the counter and the sync loop) and one connection.

### 2. A device identity that is minted once and lives outside the database

`setDeviceId(id)`, or `setDeviceIdSource(fn)` for a host running more than one
till in one process.

The properties matter more than the mechanism, and they are the ones
`apps/pos/src-tauri/src/device.rs` exists to hold:

- **Minted outside the database.** Core will not mint one. An id that lives in
  the database is an id that a restore duplicates, and two machines with one
  identity is not a recoverable state — see `045_a_claim_with_a_date_on_it.sql`.
- **Not in the backup.** For the same reason.
- **Stable across restarts.** It is what every row's provenance is attributed
  to and what the merge breaks ties on.

`tools/virtual-till/src/context.ts` shows the multi-till case: an
`AsyncLocalStorage` holding the current till, and a resolver handed to
`setDeviceIdSource`. Its own comment already names the next consumer — "the
cloud peer, which serves several shops from one supervisor".

### 3. A `fetch`

Passed in, never imported. `httpTransport(peer, fetchImpl, self)` takes it as an
argument, and so do `pairWith`, `askToJoin` and `pollJoin`.

This is not politeness about testability. The webview **cannot** fetch — the
CSP `connect-src` inherits `'self'` — so in the app the function passed in is a
shim over a Rust command. A host that has a real `fetch` passes the real one.

### 4. Optionally, a listener

A host that can answer a port calls `handleSyncRequest(db, request)` with the
bytes it received and writes back what it returns:

```ts
{ path, body, auth, remoteAddress, listenPort } → { status, body }
```

That is the whole server. It is deliberately not a server: it opens nothing,
listens to nothing and has no opinion about transport, so the thing holding the
socket is a pipe. `apps/pos/src-tauri/src/sync_server.rs` is one such pipe and
`tools/virtual-till/src/till.ts` is another, over `node:http`, and the protocol
has exactly one implementation between them.

**A host that cannot answer a port is a supported host.** It sets
`sync_peers.reach` to `'none'` for itself and says `answers: false` in its
`/hello`; nothing will dial it and it converges by asking. A phone is this, and
so is anything behind NAT. See `044_a_peer_says_how_to_reach_it.sql`.

---

## The three seams, and what happens without them

| Seam | Set with | If a host forgets |
|---|---|---|
| Device identity | `setDeviceId` / `setDeviceIdSource` | Rows are attributed to nobody; the merge tiebreak is undefined; two tills in one process silently share an identity and merge two shops into one |
| Which counter this till serves | `serveAs` / `setServingRegisterSource` | `/hello` answers with the wrong counter, so the `SAME_REGISTER` refusal fires against the wrong till or not at all |
| The clock | `setClock` | Skew detection compares against the wall clock; a test cannot move time |

All three are process-globals with an optional resolver, and the resolver form
exists for one reason: a host running several tills in one process. Core cannot
use `AsyncLocalStorage` itself — `node:async_hooks` does not exist in a webview,
and core has to run in both — so the host owns the context and hands in a
function that reads it.

---

## Starting up, in order

1. `migrate(db, MIGRATIONS)`. Refuses a database newer than this build
   (`SchemaTooNewError`) and one with no version at all
   (`SchemaUnversionedError`); both are states a host has to have an answer for.
2. `setDeviceId` / `setClock` / `setServingRegisterSource`.
3. `bootstrap(db, { shopName })` — **only** for a host that is creating a shop.
   A host joining an existing one must not: a till that bootstraps itself has
   created a *second shop*, with its own roles and counters under the same names
   and different ids, and no merge rule reconciles two things that are not two
   versions of one thing. `024` is the whole story. This is the single most
   expensive mistake available to a new host, and it looks like it worked.
4. `resetSyncState(db)` — clears `applying` after a crash mid-merge.
5. Then whatever the host is for: a loop calling `syncUntilDone`, a listener
   calling `handleSyncRequest`, or both.

---

## What core will never do

- Open a file, a socket or a port.
- Mint a device identity.
- Read an environment variable.
- Import anything from Tauri, React, or `node:*` outside the node driver.
- Decide when to sync. `apps/pos/src/core/syncLoop.ts` owns the interval, the
  backoff and the nudge, and a second host is entitled to a different policy
  entirely — a cloud peer that never initiates is a policy, not a special case.

---

## What is deliberately still missing

**Packaging.** `@shopos/core` is consumed from source inside this repository.
Nothing here needs it published, and publishing it would fix an API surface that
is still moving.

**TLS.** Everything is plain HTTP, and `syncAuth.ts` argues for why that is
right on a shop's own wire. A host that needs TLS — the cloud peer over the
internet, a phone that will not open a cleartext socket — has a field waiting
for it: `sync_peers.fingerprint`, exchanged at pairing since `047`, stored and
not yet consulted.

**A second client.** This page describes the contract so that writing one is a
known quantity. It is not an invitation to write one yet.
