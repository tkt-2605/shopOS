# Phase 4 spec — Getting it onto a shop's PC, and updating it

Source: plan *Phase 4*. Architect pass §3 (licensing), §6 (signing), §7
(the portal as one identity).

## Scope

CI on every push, a signed installer, an updater that never interrupts a
sale, three licence tiers verified offline, and the smallest portal that can
issue a licence. Plus the one item that is not code: the certificate.

## Open decisions resolved here

- **Certificate** (pass §6): OV code-signing from a CA that validates Indian
  individuals or firms, key in the CA's cloud signing service, issued to the
  proprietor by name unless the firm has Udyam or GST registration, in which
  case to the firm. Start it on day one of Phase 0; expect one to three weeks.
- **The updater key** is generated on day one, kept outside the repo, its
  public half committed in `tauri.conf.json`. Losing it means every installed
  till can never update again, so the private key is backed up to two places
  the owner controls before the first release is built.
- **Updates never restart a till on their own.** Download in the background;
  show "Update ready" in the sidebar; install on the next launch or when the
  user clicks, and never while a cash session is open.
- **One version number.** `tauri.conf.json` reads
  `"version": "../package.json"` (Tauri 2 supports the path form);
  `Cargo.toml` stays at `0.0.0` with a comment. A tag `vX.Y.Z` must equal
  `package.json`; CI refuses otherwise.
- **`installMode: currentUser` stays**; `CouldNotStart` detects a database
  under another user's profile and says so.
- **The licence token lives in `settings`** (replicated to every till),
  verified with an Ed25519 public key compiled into core; the **clock
  high-water mark** lives in `device.json`. Tiers: `single` (perpetual),
  `cloud`, `branches` (subscriptions). States: active / grace (30 days) /
  lapsed.

## File-level task list

### CI and release

- `.github/workflows/ci.yml` — on push and PR: an `ubuntu-latest` job
  (npm ci, typecheck, `vitest run` including bench Layer 1, `migrationReplay`
  on the synthetic shop) and a `windows-latest` job (`cargo test` for both
  crates, unsigned `tauri build`, artifact uploaded). `[delegate: Sonnet/Haiku]`
- `.github/workflows/release.yml` — on tag `v*`: version check, signed
  `tauri build` with `bundle.windows.signCommand` calling the CA's CLI
  (credentials in GitHub secrets), `createUpdaterArtifacts: true`, a GitHub
  Release with the NSIS installer, `.sig` and `latest.json`. `[delegate: Opus]`
  for the signing step; the rest `[delegate: Sonnet/Haiku]`.
- `tauri.conf.json` — `plugins.updater.pubkey`,
  `endpoints: ["https://github.com/<owner>/<repo>/releases/latest/download/latest.json"]`,
  `windows.installMode: "passive"`. `[delegate: Sonnet/Haiku]`
- `apps/pos/src/core/updater.ts` — check on start and every 24 h; download;
  an `updateReady` state shown in the sidebar; install gated on no open cash
  session. `[delegate: Opus]`

### Licensing

- `packages/core/src/services/licence.ts`:
  ```ts
  interface LicenceToken {
    shopId: string; tier: 'single' | 'cloud' | 'branches'
    paidThrough: string | null; tills: number; issuedAt: string; kid: string
  }
  verifyToken(raw: string, now: Date):
    { ok: true; token: LicenceToken } | { ok: false; code: 'BAD_SIGNATURE' | 'WRONG_SHOP' | 'MALFORMED' }
  entitlement(db, now): Promise<{
    tier; state: 'active' | 'grace' | 'lapsed' | 'none'
    paidThrough; graceUntil; tills; clockUnreliable: boolean
  }>
  installToken(db, ctx, raw)   // audited; refuses WRONG_SHOP against settings.shop_id
  ```
  Signature via WebCrypto `subtle.verify({ name: 'Ed25519' })` (WebView2 and
  Node 22 both support it); the raw token is `base64url(json).base64url(sig)`.
  `[delegate: Opus]`
- `services/features.ts` untouched; a new `entitled(db, feature)` in
  `licence.ts` is what the UI asks. Cloud UI (Phase 6) hides behind it; LAN
  pairing does not. `[delegate: Sonnet/Haiku]`
- `device.rs` — `clock_high_water` in `Stored.settings`, updated on every
  start; `entitlement` reports `clockUnreliable` when now is more than 24 h
  before the high-water mark. `[delegate: Sonnet/Haiku]`
- Settings → Licence card: paste a code, show tier, state and dates; "Renew"
  opens the portal URL. `[delegate: Sonnet/Haiku]`
- `apps/portal` (minimal, this phase): a Node service with a CLI
  `portal issue --shop <id> --tier cloud --paid-through 2027-03-31` that
  signs with the private key from an env var, and `GET /v1/licence/:shopId`
  that returns the current token and records the `X-ShopOS-Device` header
  with a timestamp. No user accounts yet; Phase 6 adds them to this service.
  `[delegate: Opus]`

### External dependency — not a coding task

| Item | Owner action | Lead time |
|---|---|---|
| OV code-signing certificate | Pick a CA; individual validation with government ID, or firm validation with Udyam and GST certificates; choose cloud key storage | 1–3 weeks |
| Updater keypair | `tauri signer generate`; back up the private key twice | 1 hour |
| GitHub secrets | CA credentials, updater private key | after the two above |

## Dependencies

- Phase 3's log file before the first outside install.
- The certificate blocks only the *signed* release; CI, updater code and
  licensing are built and tested unsigned in Windows Sandbox.
- Phase 6 needs `apps/portal` and `licence.ts` from here.

## Verification

- [ ] `ci.yml` green on a PR; `release.yml` produced a signed installer whose Properties → Digital Signatures shows the proprietor's name
- [ ] Clean Windows Sandbox: install; SmartScreen's warning is the reputation one, not "unknown publisher"; the app opens to setup
- [ ] Ship `v0.1.1` to the Sandbox: "Update ready" appears within the check interval; with a cash session open it does not install; close the session, click, it applies and reopens on the same database
- [ ] Tag `v0.2.0` with `package.json` still `0.1.1`: CI refuses
- [ ] Licence: a `single` token gives active with no expiry. A `cloud` token paid through yesterday gives grace with a date 30 days out. Clock at +31 days: lapsed; billing and LAN sync still work; the cloud card says why. Clock at −2 days from the high-water mark: `clockUnreliable`, state unchanged
- [ ] A token for another `shop_id` is refused with `WRONG_SHOP` and audited
- [ ] `CouldNotStart` on a Sandbox with the database under a second Windows user names that user
