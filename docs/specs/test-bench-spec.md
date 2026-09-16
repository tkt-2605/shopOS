# Test bench spec — two tills on one machine

Source: plan section *The test bench — because there is only one machine*.
Architect pass §5 (Layer 2 on hosted CI).

## Scope

Build the three layers the plan describes so that every multi-till claim after
Phase 0 is asserted from both ends on one PC and in CI. Layer 1 is the required
check; Layer 2 is nightly and manual; Layer 3 is a written procedure, not code.
The headless till is also the first commit of the Phase 6 cloud peer, so it is
built as a package, not a test helper.

## Open decisions resolved here

- **Discovery is Rust, the till is Node.** `discovery.rs` and `sync_server.rs`
  move into a workspace crate `crates/shopos-net` with a binary. The container
  runs the Node till and that binary side by side. Without this, Layer 2 cannot
  test discovery at all, which is the one thing it exists for.
- **Clock and transport are injected, never monkey-patched.** Core gets one
  `clock.ts` seam; the bench gets a wrapping transport. No `vi.useFakeTimers`
  across process boundaries, because the bug class being hunted is two
  processes disagreeing.
- **Layer 2 is never a required check.** `workflow_dispatch` + nightly. The
  first job is a two-container UDP broadcast smoke; if hosted runners fail it,
  the workflow prints "self-hosted only" and exits 0.

## File-level task list

### Core seams (Phase 1d and everything after depend on these)

- `packages/core/src/clock.ts` — `export const clock = { now: () => Date.now() }`
  and `setClock(fn)`. Replace every `Date.now()`/`new Date()` in
  `services/sync.ts`, `services/syncClient.ts`, `services/syncServer.ts`,
  `services/pairing.ts` (HMAC timestamp, nonce window, merge tiebreak) with
  `clock.now()`. Billing and audit keep `ctx.now?.()` as they are. `[delegate: Opus]`
  — the merge tiebreak and the ±5 min signing window are where skew bites, and
  the replacement must not touch posting dates.
- `packages/core/src/services/syncClient.ts` — `httpTransport(peer)` already
  returns a function; export its type as `Transport` so a wrapper can be
  typed. `[delegate: Sonnet/Haiku]`

### `tools/virtual-till` (package `@shopos/virtual-till`, Node, no Tauri)

- `src/till.ts` — `startTill(opts): Promise<Till>` where
  ```ts
  interface TillOptions {
    dataDir: string            // its own SQLite file + attachments dir
    deviceId: string           // setDeviceId() — process-global is right here
    label: string
    registerPrefix: string     // createRegister() on first start; refused if the shop has it
    port: number               // 0 = ephemeral
    clock?: () => number       // setClock()
    transport?: (inner: Transport) => Transport
    seed?: 'empty' | 'shop'    // 'shop' = tools/seed-large (see Phase 2c)
  }
  interface Till {
    db: SqlDriver; url: string; deviceId: string
    pairWith(other: Till): Promise<void>          // typed-code pairing, both directions recorded
    sync(other: Till): Promise<SyncRound>         // THIS till initiates
    stop(): Promise<void>
  }
  ```
  HTTP via `node:http`, routed to `handleSyncRequest` exactly as
  `sync_server.rs` does; `serveAs(registerId)` set on start. `[delegate: Opus]`
- `src/faults.ts` — `withFaults(transport, faults)` where faults are
  `{ dropReplyAfterCommit?: number, delayMs?: number, partitioned?: () => boolean }`.
  "Drop reply after commit" forwards the request, awaits the real response,
  then throws — the far side has committed and the near side does not know.
  `[delegate: Sonnet/Haiku]`
- `src/cli.ts` — `virtual-till serve --data DIR --device ID --register PFX --port N`
  for the container and for hand testing. `[delegate: Sonnet/Haiku]`
- `package.json` with `bin`; added to root `workspaces`. The Vite alias for
  better-sqlite3 is unaffected because this package is never bundled.

### Scenarios — `tools/virtual-till/test/*.test.ts` (Layer 1, runs in `npm test`)

Each is one file, one describe, asserted on the **stored rows of both tills**,
never on a return value alone.

| File | Assert |
|---|---|
| `host-initiates.test.ts` | Host pairs, joiner writes a bill, **host** calls `sync(joiner)`, host has the bill. Then joiner writes nothing, host syncs: `received === 0`, and the report says "nothing to sync with" only when `pairedPeers()` is empty, never when a peer was contacted |
| `offline-and-back.test.ts` | Partition joiner, host syncs 3×: backoff grows, no throw escapes; heal; next round carries everything |
| `skewed-clocks.test.ts` | Same customer row edited on both, clocks 5 min apart; the merge picks per the documented rule and the loser lands in `sync_conflicts`; signing still accepted at 4:59 and refused at 5:01 |
| `lost-reply.test.ts` | `dropReplyAfterCommit: 1`; the retry must not duplicate the bill (`/offer` idempotency on `origin_id`+`rev`, not on a cursor rewind) |
| `schema-skew.test.ts` | Till at schema N vs N−1: accepted when the delta is additive, `SCHEMA_MISMATCH` otherwise (lands with Phase 2c; skipped until then) |
| `third-till.test.ts` | Two tills with `seed: 'shop'` and 200 bills of traffic; a third joins; row counts equal on all three |
| `same-register.test.ts` | Two tills on prefix `MR`: `SAME_REGISTER` refusal, and no bill number ever minted twice |

### `crates/shopos-net`

- Cargo workspace at repo root (`Cargo.toml` with
  `members = ["apps/pos/src-tauri", "crates/shopos-net"]`).
- `src/discovery.rs`, `src/sync_server.rs` moved verbatim; the Tauri app
  depends on the crate and keeps its command wrappers. `[delegate: Opus]` —
  the listener hands requests to the webview through Tauri events; the crate
  exposes a trait `Answerer` so the app's implementation stays in the app and
  the binary can answer by forwarding to the Node till on localhost instead.
- `src/bin/shopos-net.rs` — `answer --port 7802 --sync-port N --device ID`
  and `look-around --timeout 3s`. `[delegate: Sonnet/Haiku]`
- The 65 Rust tests keep passing under the new crate.

### Layer 2 — `docker/bench/`

- `Dockerfile`: `node:22-bookworm` plus the `shopos-net` binary built in a
  `rust:1.77` stage. `[delegate: Sonnet/Haiku]`
- `compose.yml`: networks `shop-a`, `shop-b`; services `till-a1`, `till-a2`
  (shop-a), `till-b1` (shop-b); one named volume each. `[delegate: Sonnet/Haiku]`
- `run.sh`: brings the stack up, runs `look-around` from `till-a1`, asserts it
  finds `till-a2` and **not** `till-b1`, then runs `host-initiates` across the
  real network. `[delegate: Sonnet/Haiku]`
- `.github/workflows/bench-layer2.yml`: `workflow_dispatch` + `schedule`
  nightly; job 1 is the broadcast smoke; job 2 runs `run.sh` only if job 1
  passed.

## Dependencies

- Needs Phase 0 only for `noUnusedLocals` (the new package is written under it).
- The clock seam must land **before** Phase 1d's host-sync fix, because the
  fix's test is `host-initiates.test.ts`.
- `schema-skew.test.ts` waits for Phase 2c.
- Nothing here needs Drizzle.

## Verification

- [ ] `npm test` runs the six non-skipped scenarios in under 60 s on the dev PC
- [ ] `host-initiates.test.ts` **fails** against the tree before the 1d fix and passes after; run it both ways and keep the failing output in the PR
- [ ] `skewed-clocks.test.ts` passes with `clock` set 5 min apart in the two processes, not with fake timers
- [ ] `cargo test -p shopos-net` passes; `cargo test` in the app still passes; the app still pairs over Wi-Fi as verified this week
- [ ] `docker compose -f docker/bench/compose.yml up` on the dev PC: `look-around` from `till-a1` lists `till-a2` only
- [ ] `bench-layer2.yml` has run once on a hosted runner and the smoke result is in the workflow summary either way
- [ ] Layer 3 procedure written to `docs/specs/layer3-procedure.md`: Windows Sandbox install, update, restore, power-cut on a VM — one page, each step naming the file it produces

---

## Built — what was resolved differently, and why

Added after the build, so the next reader gets the decisions and not just the
intent. Everything below departs from the text above it; everything not
mentioned was built as specified.

- **`pairing.ts` does not exist.** The HMAC timestamp, the nonce window and the
  signing tolerance are in `services/syncAuth.ts`. The clock seam landed there.

- **`SyncTransport` was already exported**, so nothing needed renaming to
  `Transport`. The bench wraps the existing type.

- **Tills run in one process, not one each.** `AsyncLocalStorage` gives each
  till its own device id, counter and clock across every `await`, including
  inside an HTTP handler. The set-and-restore pattern the old HTTP test uses is
  unsound the moment two tills interleave, which these scenarios do on purpose.
  Core gained three resolver seams for it (`setDeviceIdSource`,
  `setServingRegisterSource`, `setClock`); `node:async_hooks` stays out of core
  because the webview has no such module. Layer 2's containers give the real
  process isolation. See `tools/virtual-till/src/context.ts`.

- **"The port header the joiner already sends" did not exist.** It had to be
  built: `LISTEN_PORT_HEADER` (`x-shopos-port`), the caller's address taken
  from the socket by whoever holds it, and `peerAddressFrom` composing the two.
  This is the substance of the 1d fix, and the app half — `sync_server.rs`
  through to `syncHost.ts` and `syncLoop.ts` — landed with it.

- **`host-initiates.test.ts` failed before the fix**, as required. The output is
  kept at `docs/specs/evidence/host-initiates-before-1d.txt`. The cause was
  precisely as predicted: the host's peer row had a secret and no address, and
  `pairedPeers` filters on `address IS NOT NULL`.

- **The backoff moved into core** (`services/syncBackoff.ts`). The scenario asks
  for "backoff grows", and the arithmetic lived in `apps/pos/src/core/syncLoop.ts`
  where the bench cannot reach it. Worth saying why the distinction it encodes
  matters: `syncWith` *throws* when a peer cannot be reached and *returns*
  `{ok:false}` when it was reached and refused. Backing off from a refusal would
  be wrong. `Till.sync` catches the throw and reports `UNREACHABLE`, so the
  bench asserts the layer a shop actually experiences.

- **A control channel was needed for Layer 2.** A till in a container has nobody
  to press "offer a code" or "sync now", so the CLI takes `--control N` and
  serves those operations on **loopback only** — `tools/virtual-till/src/control.ts`
  says why that is the single option and not a default. Each operation maps
  one-to-one onto something a shopkeeper can already do.

- **`look-around` takes `--device`.** A till answers its own broadcast: the
  responder cannot recognise the asker, they are different sockets. The app
  drops its own reply in the webview, which knows what machine it is; the
  binary has to be told.

- **The Dockerfile does not copy the workspace root manifest.** Cargo resolves
  every member before building one, and the Tauri app is a member — copying it
  would drag webkit and the Windows crates into an image that needs neither.

- **Three discovery tests were sharing port 7802 and stopping each other.**
  Cargo runs them on parallel threads in one binary; only the first could bind,
  the others were answered by its responder, and the first to finish killed it.
  They passed alone and timed out on a loaded machine. `respond_on(0, ..)` gives
  each its own ephemeral port and confirms the bind before anyone probes —
  UDP has no retransmit, so a probe sent a millisecond early is simply gone.
  Six consecutive clean `cargo test` runs after the change.

- **Rust test count: 69**, from 66. The three new ones cover the port header and
  the insistence that the caller's address comes from the socket, not a header.

### Two bugs Layer 2 found that Layer 1 could not

Both are the same shape, and it is the shape the layer exists for: **the
process that decides what a request means is not the process that saw who sent
it.** In-process they are one socket, so no in-process test can tell them apart.
The app has the same split — Rust holds the socket, the webview holds the
database — so neither of these was an artefact of the containers.

1. **Chunked replies.** Node adds `Transfer-Encoding: chunked` to any response
   with no declared length. `fetch` unchunks it silently, so Layer 1 never saw
   it; `shopos-net` reads the socket and takes what follows the blank line, so
   the first pairing inside a container came back as `d7
{"secret":...` and
   failed to parse. Fixed at both ends: the Node till now sends
   `content-length`, and the forwarder de-chunks anyway, because one that only
   works against a cooperative server breaks the next time somebody changes it.

2. **A till that synced with itself.** The till saw `127.0.0.1` for every caller
   — genuinely who connected to it, since `shopos-net` forwards over loopback —
   and recorded the peer as being on loopback. The next host-initiated round
   dialled its own till, which answered `UNKNOWN_PEER`, because a till is not
   its own peer. It also advertised the port it *binds* (7803) rather than the
   one the outside world reaches it by (7801). Both fixed: `x-shopos-remote` is
   trusted **only** from loopback, where it can only have come from our own
   forwarder, and `advertisePort` says what to tell a peer to come back on.

Neither could have been caught by a nightly Docker run alone either — a red
mark once a night is not a debugging tool. So both are now pinned by
`behind-a-forwarder.test.ts` in Layer 1, which runs in `npm test` and fails in
under two seconds.

Layer 2 output from the passing run: `docs/specs/evidence/layer2-passing.txt`.
