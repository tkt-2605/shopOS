# Pushing updates

How a new version of ShopOS gets from a tag to every till in every shop,
without closing a counter mid-sale, without splitting a shop's tills across a
schema they cannot sync over, and without a licence ever standing in the way.

Written 2026-09-26 from a read of the code as it stands. Nothing here is built
yet except where "Today" says so.

## Today

| Piece | State | Where |
|---|---|---|
| When to check, when it is safe to install | Built and tested: 24 h check, `canInstall` refuses while a cash session is open, no forced update | `packages/core/src/services/update.ts`, `test/update.test.ts` |
| Platform half | Written against the Tauri updater plugin's shape; download and install are separate calls | `apps/pos/src/core/updater.ts` |
| Mounted in the app | **No.** Nothing calls `createUpdater`, so no sidebar line and no Install button | — |
| Updater plugin | **Not installed** (no crate, no npm package, no capability). crates.io and npm are blocked on this machine | `src-tauri/Cargo.toml`, `capabilities/main.json` |
| Feed URL | `UPDATE_FEED_URL = null`, pinned by a test | `core/src/config/licensing.ts`, `licencePlaceholders.test.ts:63` |
| Updater config | Example only, with a v1 `active` key and a github.com endpoint | `src-tauri/updater.example.json` |
| Version number | Literal `0.1.0` in three places | `tauri.conf.json`, `Cargo.toml`, `apps/pos/package.json` |
| Mixed schemas between tills | Built: each side checks the other's floor; unknown columns are trimmed | `sync.ts:194-206`, `syncServer.ts:498-521, 595`, `schema-skew.test.ts` |
| Schema floor | `MIN_PEER_SCHEMA_VERSION` = 33 (last breaking migration is 032); head is 50 | `db/migrationKinds.ts`, `db/schemaVersion.ts` |
| Backup before migrating | **None.** The daily backup runs after `migrate()` | `CoreProvider.tsx` `startOnce()` |
| Downgrade | Impossible once migrated (`SchemaTooNewError`) | `db/migrate.ts` |
| CI / release pipeline | Only a nightly bench workflow; no `ci.yml`, no `release.yml`, no tags | `.github/workflows/` |
| Code signing | Not set up; CA not chosen | — |
| Vendor sees versions | Portal has `devices.version`, but no till ever calls the portal | `apps/portal/src/store.ts` |

## Principles

1. **Never close a counter mid-sale.** Install is always a person's click, and
   only when nothing is in flight. The best moment is shop close.
2. **Roll forward, never back.** A bad release is halted and replaced by a
   patch. Downgrades are not offered; the recovery path is restore + previous
   installer, by hand.
3. **A shop's tills move together when they must.** A release that raises the
   schema floor is held until every till in the shop can take it.
4. **Back up before anything irreversible**: before install and again before
   migrating.
5. **Updates are never gated on the licence.** A lapsed shop on a buggy build
   is a shop that cannot bill properly.
6. **One version number**, and the tag must equal it.

## Release flow at a glance

```
tag v0.5.0 ─▶ release.yml ─▶ signed installer + .sig + latest.json (rollout 0, draft)
                                   │
                    promote.yml ───┼─▶ beta   100%   (vendor's till + a willing shop, a few days)
                                   ├─▶ stable  10%   (watch)
                                   ├─▶ stable  50%   (watch)
                                   └─▶ stable 100%
                    halt = promote with 0%
```

A till checks `https://updates.<domain>/<channel>/latest.json` once a day,
decides with a pure core rule whether this shop takes this release, downloads
in the background, and shows one line in the sidebar. The shopkeeper installs
at closing time.

## The plan, in order

### 0. Owner decisions (not code, start now)

- Generate the updater keypair once (`npx tauri signer generate`). Keep the
  private key and its passphrase **apart**, each in two offline places, plus
  GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`. Losing it means
  every till must be updated by hand once.
- Choose a vendor-owned feed domain (`updates.<domain>`), never a github.com
  URL baked into tills. A renamed or private repo would strand every install.
- Decide where release files live so tills can reach them: a public
  releases-only repo or object storage behind the domain.
- Order the OV code-signing certificate (1-3 weeks). The deciding test: its
  cloud signing CLI must run headless on GitHub's `windows-latest`.
- Layer 3 needs a Windows machine with Sandbox or a VM: Windows 11 Home has no
  Sandbox (`owner-readiness.md` row 6 says otherwise and should be corrected).

### 1. One version number

`tauri.conf.json` reads `"version": "../package.json"`; `apps/pos/package.json`
is the source; `Cargo.toml` is `0.0.0` with a comment.

- Patch: fixes, no migration.
- Minor: features, or any migration.
- A release with a **breaking** migration is at least minor and says
  `breaking: true` in its manifest.
- Tags are `vX.Y.Z`, beta tags `vX.Y.Z-beta.N`. The identifier `com.shopos.pos`
  never changes, because the data folder keys on it.

### 2. `ci.yml`, buildable now and unsigned

On every push and PR:
- `npm ci`, `npm run typecheck`, `npm test`
- `cargo test --workspace`
- an unsigned `tauri build` whose installer is kept as an artifact
- a **migration lint** (`tools/release/check-migrations.mjs`) that fails when
  a migration marked additive contains `DROP`, `RENAME`, a table rebuild or a
  stricter check, or **adds a column to a line table**. Line tables are rewritten
  DELETE+INSERT on merge (`sync.ts` ~783), so an older till would reset the new
  column to its default. A deliberate exception carries `-- kind-reviewed:`.

### 3. Install the plugin where there is network

In CI or on another PC, not here:
- Add `tauri-plugin-updater` and `tauri-plugin-process` to the Rust side and
  the matching npm packages, register them, and grant `updater:default` and
  `process:allow-restart`.
- Commit the lockfiles from there.
- Merge the updater config with the real public key and the `updates.<domain>`
  endpoint, and drop the v1 `active` key.
- Keep **one** source of truth for the feed: the plugin config. Delete
  `UPDATE_FEED_URL` or derive it, and change the placeholder test on purpose.
- Fence off dev builds. `tauri.tillN.json` and `tauri.demo.json` override the
  endpoint, and at run time nothing is checked unless the identifier is
  `com.shopos.pos`, so till 4 can never install the production app over itself.

### 4. A richer manifest and a pure policy rule

`latest.json` gains `schema`, `minPeerSchema`, `breaking`, `channel` and
`rollout { percent, since }`. A new `packages/core/src/domain/updatePolicy.ts`,
pure and DB-free, answers `offer | hold | wait-for-peers`:

- **Rollout bucket** = `sha256(shopId + version) mod 100 < percent`. It is keyed
  on the shop, not the till, so a shop's tills cross together.
- `percent 0` halts a release.
- **wait-for-peers** when `minPeerSchema` is above the recorded schema of a
  peer seen in the last 14 days.

### 5. Channels per shop

- A replicated setting `update_channel`: `stable` by default, `beta` opt-in.
  The owner sets it once and it syncs to every till.
- The check runs in Rust, not the webview (`update_check`, `update_download`,
  `update_install`), with a short timeout.
- A failed check stays silent.

### 6. Mount it in the app

Create the updater once after the counter is ready: check at start, then every
24 h.
- One line in the sidebar, never a dialog.
- The Install button calls `apply()`.
- Also offer the install right after a drawer is closed and in the shop-close
  flow.
- Remember in `device.json` that an update is ready, so a till switched off
  overnight fetches it again before the drawer opens.

### 7. Tighter "safe to install"

`canInstall` keeps the open-cash-session rule, which covers every till because
sessions replicate. It adds, each with its own sentence:
- `SUBMIT_IN_PROGRESS`: a bill or payment is being saved. Today a shop that
  never opens a drawer has **no** protection.
- `SYNC_APPLYING`: a sync round is mid-transaction.
- `BACKUP_FAILED`: the pre-update backup did not succeed. The person may
  override.
- `PEERS_BEHIND`: from step 4.

Open draft bills do not block, because they are already autosaved.

### 8. Back up twice

- **Before install**, in `apply()`: `before-update-<from>-to-<to>-<date>.zip`,
  and run the off-site hook.
- **Before migrating**, in `startOnce()` ahead of `migrate()`, whenever the
  database is behind the build: `VACUUM INTO before-schema-<from>-<to>-<date>.db`.
  This also covers a USB install and a second company book opened later.
- Both kinds are "safety" backups: never pruned by the daily rule, last 3 kept.
- If the backup fails, still migrate, because the shop must bill. Turn the
  Backups card and the top-bar dot red.

### 9. Rollback runbook

- **Halt:** promote the bad release to 0%.
- **Fix:** ship a patch release.
- **Keep:** every signed installer, permanently, on the release host.
- **For a till broken by a migration:** restore the `before-schema` backup, run
  the previous installer, and let sync pull back bills from the other tills.

Bills rung up on that till after the update and never synced are lost by a
restore, and the runbook must say so. Rehearse it once by hand in Layer 3.

### 10. Mixed versions in one shop

- **Additive release:** tills update on their own schedule and keep syncing.
- **Breaking release:** the two sides refuse each other until both are updated.
  To make that survivable:
  - Hello, pairing and batch answers carry `appVersion`. `sync_peers` stores
    `their_schema`, `their_app_version` and `their_version_at`. That is an
    additive migration with the usual three parts plus `schema.ts` and
    `docs/schema.md`.
  - The sync screen shows each counter's version. The mismatch sentence names
    the till and the version: "Counter 2 is on 0.4.1; update it to 0.5.0".
  - `wait-for-peers` makes the sidebar say "This update goes on every till
    together". Each till installs only with the owner's confirmation, ideally
    all at closing.
- **Development rule, expand then contract:** ship the additive half, wait
  until every shop's tills report it (step 13), and only then ship the breaking
  half.

### 11. `release.yml`, which waits only on the certificate

On a `v*` tag:
1. Refuse unless the tag equals `apps/pos/package.json`.
2. Run the CI jobs.
3. Do a signed `tauri build` with the CA's `signCommand`, RFC 3161 timestamping
   and updater artifacts on.
4. Write `latest.json` with `tools/release/manifest.mjs`. It reads the schema
   constants, compares them with the previous tag, sets `breaking` itself, and
   starts rollout at 0.
5. Publish a **draft** release.

Nothing reaches a till until the next step.

### 12. Promotion

`promote.yml` takes tag, channel and percent, and copies the manifest to
`updates.<domain>/<channel>/latest.json`.
- **Normal path:** beta 100% for a few days, then stable 10%, 50% and 100%,
  with a watch period between.
- **A breaking release** goes to stable only after the preceding additive
  release is on about 100% of tills seen.

### 13. Vendor visibility

- Every update check sends `X-ShopOS-Device`, `-Shop`, `-Version`, `-Schema`
  and `-Channel`: opaque ids and versions only, no bill data. The daily check
  becomes the till's heartbeat. It goes through the plugin's HTTPS client, so
  it does not wait on TLS in `shopos-net`.
- Once the portal has a domain and TLS, it becomes endpoint 1:
  - `GET /v1/update/:channel` serves the same manifest and records the device.
  - The portal's `devices` table gains `schema`, `channel` and
    `last_update_check`.
  - A `portal versions` command lists shops, tills, versions, last seen, and
    who is stuck below a floor.
- The static host stays as endpoint 2.

### 14. The licence stays out of it

- A test asserts that `update.ts`, `updatePolicy.ts` and `updater.ts` import
  nothing from the licence code.
- A test asserts that a lapsed or missing licence still gets an update offer.
- The portal route test asserts that `/v1/update` serves an unlicensed shop.
- `licensing-and-accounts.md` gains the row "updates are never gated".

### 15. Offline and late shops

- **USB path:** the signed installer, run by hand, updates in place (same
  identifier, same data folder).
- **Released fixtures:** one database per released schema, under
  `tools/fixtures/released/<schema>.db`, and a test that migrates each to head.
  Any old install can then cross any gap.
- **Later, optional:** fetch the installer from another till on the LAN. The
  signature makes the source irrelevant. Park it until mobile tills settle
  hub-and-spoke sync.

### 16. Layer 3 sign-off, by hand

Extend `layer3-procedure.md`:
- Install the previous release, bill, update. Confirm it refuses with a session
  open, that both safety backups exist, and that the bills survive.
- **Two tills, additive release:** they keep syncing and show each other's
  version.
- **Two tills, breaking release:** both refuse with the new sentence, then
  converge once both are updated.
- A mismatched tag is refused by CI.
- A dev till never offers an update.
- SmartScreen shows the publisher name.

## What can be built now, on this machine

Steps 1, 2, 4, 7, 8, 10, 14 and 15 are pure code and tests, and need no
network, key or certificate. Steps 3, 5, 6 need the plugin (network). Steps 11
and 12 need the certificate and the domain. Step 13 needs the portal hosted.

## Risks

| Risk | Mitigation |
|---|---|
| Updater key or passphrase lost | Two offline copies each, kept apart. A signed installer run by hand still updates in place. Rotation ships signed with the old key and carrying the new one. |
| A breaking migration filed as additive corrupts two tills' books quietly | Migration lint (step 2), the existing bias toward "breaking", expand/contract |
| A new column on a line table is reset by an older till | The lint treats it as breaking, or the line merge keeps columns the sender did not send |
| One till on a breaking release is cut off for days | wait-for-peers, owner confirmation, install at close. Each till keeps billing regardless. |
| A migration fails part-way on real data | before-schema backup, released-fixture replay, beta first, staged rollout with halt, runbook |
| A dev till installs production over itself | Endpoint overrides plus an identifier guard |
| Private repo or rename strands tills | Vendor-owned domain in front of whatever hosts the files |
| The certificate cannot sign in CI | Headless signing is the CA selection test. Timestamp everything. |
| Install mid-sale in a shop that never opens a drawer | Install is a click. Add the `SUBMIT_IN_PROGRESS` refusal. Offer at close. |
| Update check seen as tracking | Only opaque ids and versions, stated in the privacy note |
| Someone later gates updates on the licence | The step 14 tests and a row in the licensing spec |

## Open questions

1. Feed domain: is `github.com/tkt-2605/shopOS` public or private, and should
   releases go to a separate public repo or to object storage?
2. Which CA, and is the certificate in the proprietor's name or the firm's
   (Udyam or GST)?
3. If the pre-migration backup fails, warn (plan's default, because the shop
   must bill) or block?
4. For a breaking release, does the owner confirm once (replicated) or on each
   till? Is it restricted to shop close?
5. Rollout pace: beta 100%, then stable 10, 50 and 100 over about a week? Is
   there a first beta shop besides the vendor's own?
6. May tills call the update host before Phase 6, or should visibility wait for
   the portal?
7. Should releases ever force a stepping-stone version (`minFromVersion`), or
   keep migrating from schema 1 forever as today?
8. Where does Layer 3 run: a Pro VM, VirtualBox, or a second PC?
