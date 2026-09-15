# Phase 6 spec — The cloud tier

Source: plan *Phase 6*. Architect pass §1 (Turso reached only from the cloud
peer), §4 (rclone stays), §7 (one identity), §9 (WhatsApp API).

## Scope

One more peer, hosted. The headless till from the bench runs per shop against a
Turso database, tills pair with it the way they pair with each other, and the
portal serves the owner's phone from the same database. Four deliverables in
the plan's order: off-site copy and remote support, internet sync, phone view,
diagnostics upload. WhatsApp Cloud API as a fifth if the paperwork clears.

## Open decisions resolved here

- **Spike first, one day**: run the full migration list and the feed triggers
  against `turso dev`, then a two-till sync through the cloud peer on the
  bench. Pass criteria: `PRAGMA defer_foreign_keys` honoured inside a write
  transaction; `AUTOINCREMENT` and `AFTER UPDATE … WHEN NEW.rev = OLD.rev`
  triggers behave as in SQLite; `@libsql/client` interactive transactions hold
  `BEGIN IMMEDIATE` semantics. If any fails, the cloud peer keeps a plain
  SQLite file on a VPS behind the same `SqlDriver`, and Turso is dropped
  without touching anything else.
- **The cloud peer is one more device.** It has a `device_id`, pairs with a
  portal-issued secret rather than a typed code, listens on HTTPS, and is
  refused by the same `DIFFERENT_SHOP`/`SCHEMA_MISMATCH` rules. It never
  initiates; tills initiate to it. It is not a host, so the host-initiates
  lesson does not apply, and it has no LAN address to remember.
- **Multi-tenancy is one process per shop.** Isolation by process and by
  database, matching the standing note that the cloud is one database per shop
  and core never learns the word "tenant". A supervisor starts a peer per
  active shop on demand and stops it after idleness.
- **The backup is not the replica.** A nightly dump of each shop database to
  object storage the vendor controls, 30 daily and 12 monthly, plus Turso's
  point-in-time restore. The shop's rclone copy continues.
- **Phone view auth** is the shop account on the portal: owner email and
  password (argon2), session cookie, one account per shop, more owners later.
  Read-only endpoints: today's takings, sales by hour, top items, low stock,
  outstanding khata. No writes from the phone in this phase.
- **Downgrade**: the replica is read-only for 90 days, then deleted; an email
  at both points; the phone view shows the frozen date. Local and rclone
  untouched.

## File-level task list

- `tools/virtual-till` gains `--driver libsql --url … --token …` and `--tls`;
  `handleSyncRequest` unchanged. `[delegate: Sonnet/Haiku]`
- `services/pairing.ts` — `pairWithCloud(db, {url, secret})` writes a
  `sync_peers` row with `kind: 'cloud'` (an additive column) and no LAN
  address; `syncLoop.ts` treats it like any peer and skips discovery for it.
  `[delegate: Opus]`
- `apps/portal` — shop accounts (`accounts`, `sessions`);
  `POST /v1/shops/:id/cloud` provisions the Turso database through the
  platform API, starts the peer, returns `{url, secret}` for Settings to
  install; `GET /v1/shops/:id/dashboard` read-only JSON for the phone view;
  `POST /v1/shops/:id/diagnostics` accepts the Phase 3 bundle, cloud tier
  only, consent flag stored. `[delegate: Opus]`
- `apps/phone` — a small mobile web app (same React stack, no Tauri) over
  the dashboard endpoint. `[delegate: Sonnet/Haiku]`
- Settings → Cloud card: "Connect this shop", status per till (last seen),
  "Send diagnostics" with the one-time consent. `[delegate: Sonnet/Haiku]`
- Remote support: with consent, the vendor opens a read-only copy of the shop
  database from the nightly dump; no live access to the shop's database. A
  portal page, not an app feature. `[delegate: Sonnet/Haiku]`
- WhatsApp Cloud API — the bill PDF as a utility template message through a
  BSP; behind the cloud tier and behind Meta verification. Start the paperwork
  the day Phase 6 starts: GST or Udyam certificate, a number not on consumer
  WhatsApp, template approval. `[delegate: Opus]` for the template and
  delivery-status handling.

## Dependencies

- Phase 4's portal skeleton and licence tokens; Phase 3's diagnostics bundle;
  Phase 2b's driver; the bench's headless till.
- The spike gates everything else here.

## Verification

- [ ] The spike log committed as `docs/specs/spike-turso.md` with the three pass/fail lines
- [ ] Bench: two tills and a cloud peer on `turso dev`; till A offline, till B bills, A returns and catches up through the cloud without ever reaching B
- [ ] A lapsed cloud licence: tills keep syncing on the LAN; the cloud peer refuses with a message naming the date; nothing is un-paired
- [ ] A nightly dump restored into a fresh headless till opens, `integrity_check` ok, bill count equals the shop's
- [ ] The phone view on a real phone over mobile data shows today's figures within 45 s of a bill on the till
- [ ] Diagnostics upload is refused before consent, and the consent is audited
- [ ] Downgrade a test shop: replica read-only, email received, phone view frozen with the date; the rclone backup still ran that night
