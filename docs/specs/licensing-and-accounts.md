# Licensing, accounts and updates

What was built, what is deliberately a placeholder, and the exact steps to
turn each placeholder into the real thing. Part of Phase 4; the account half
reaches forward into Phase 6, because the portal that issues a licence and the
portal that holds an owner's account are the same service and splitting them
would have meant writing it twice.

Nothing here is wired to a live third party. Every integration point is a
named function with the paperwork it needs written above it.

---

## The rule that shapes all of it

**A licence never stops a shop billing.** Not lapsed, not missing, not forged,
not when the clock is wrong, not when the portal has been down for a year.

This is not a kindness, it is the product. The counter works with the line
down is the first rule in `CLAUDE.md`, and a payment dispute is not a reason
to stand between a shopkeeper and a customer holding cash. It is also the only
rule that makes the rest of the design simple: because nothing has to be
blocked, nothing has to be enforced, and the whole licensing system is allowed
to fail open.

What a licence gates is the four things that cost the vendor money per shop
per month:

| Gated | Needs |
|---|---|
| `cloudPeer` | cloud |
| `phoneView` | cloud |
| `diagnosticsUpload` | cloud |
| `branches` | branches |

That list is asserted in `licencePlaceholders.test.ts`, so adding a fifth
entry means changing a test that says out loud what the list is for. A bill, a
print, a backup, the LAN, a report — none of them can ever appear on it.

Over-running the till count is the same shape: `overTillLimit` returns *how
many over*, and nothing turns that number into a refusal. A shop that opens a
fourth counter on a Saturday has not done anything wrong; it has done
something to invoice for on Monday.

---

## The licence itself

`base64url(payload).base64url(signature)`, Ed25519 over the payload text.

Not JWT. JWT's header carries the algorithm, so a verifier has to remember to
refuse `alg: none`, and the list of products where somebody forgot is long.
Here the algorithm is Ed25519 because `domain/licence.ts` says so and there is
nowhere in the format to write anything else.

Ed25519 through WebCrypto, which WebView2 and Node 22 both support — so the
till, the portal and the tests all verify with the same code and no
dependency.

```
shopId       the shop it was issued to, checked against settings.shop_id
tier         single | cloud | branches
paidThrough  YYYY-MM-DD business date, or null for perpetual
tills        how many counters were paid for (advisory)
issuedAt     ISO instant
kid          which signing key
```

`kid` is inside the payload so a key can be rotated without every till in the
field breaking at once: a build carries the old key and the new one until the
last licence issued under the old has expired. A till that meets a `kid` it
does not know says `UNKNOWN_KEY`, which is a different sentence from
`BAD_SIGNATURE` on purpose — one is an out-of-date till and the other is a
forgery.

### Where it is stored

In `settings`, which replicates. A licence is a fact about a shop, not about a
counter: paste it at the front till and the back one has it. The signature
travels with it and the receiving till verifies it itself, so there is no path
where a peer's say-so installs a licence.

`clock_high_water` is the exception and lives in the device store, because it
is a fact about one machine. Replicating it would let the till with the
worst clock poison every other till's idea of what time it is.

### The clock

A licence that expires can be defeated by winding the clock back, and the
usual answer — refuse to run — is not available here. So the clock is
*witnessed*, not enforced: every start records the latest instant this machine
has ever seen, and an entitlement computed more than 24 hours before that mark
reports `clockUnreliable`. The screen says the date looks wrong; everything
keeps working. A flat CMOS battery is not a reason to close a shop.

---

## Accounts

**Phone number and a six-digit code.** Owner accounts, in the portal — not
staff at the till.

That split is the important one. Staff sign in at the counter with a username
and a password, offline, exactly as they do today (`services/auth.ts`). An OTP
needs a network, the counter must work without one, and a code that does not
arrive must never stand between a cashier and a customer. So phone sign-in is
for the portal: licences, billing, the cloud tier, the phone view.

### The rules, and what each one costs when wrong

| Rule | Value |
|---|---|
| Code | 6 digits, `randomInt` (no modulo bias) |
| Lifetime | 5 minutes |
| Attempts | 5, then the challenge is dead even for the right code |
| Resend cooldown | 60 seconds |
| Per number, per hour | 5 challenges |
| Session | 30 days |

Only a hash of the code is stored, salted by the challenge's 128-bit id. Only
a hash of the session token is stored. A dump of the portal database is not a
set of working logins, and a test asserts the code appears in no column.

`start` answers identically whether or not the number has an account, and the
account is created on first successful verification — otherwise the portal is
a free service for checking which phone numbers are ShopOS customers.

A provider outage writes **no** challenge row, so a bad evening at the SMS
provider cannot use up somebody's hourly quota and lock them out.

### Sending the code

`OtpChannel` is one method: put six digits in front of somebody. The portal
keeps the code, the expiry, the attempt count and the decision.

That split is deliberate and load-bearing. Several providers — Telegram's
Gateway among them — will generate *and verify* the code for you. Taking that
offer moves the security decisions inside a vendor and makes swapping vendors
a rewrite of sign-in. So we always send our own code.

| Channel | State |
|---|---|
| `console` | real, development. Prints the code |
| `memory` | real, tests |
| `telegram` | **written, needs a token.** Telegram Gateway API |
| `sms` | **placeholder.** See below |
| `whatsapp` | **placeholder.** Phase 6, behind Meta verification |

`firstThatWorks([...])` chains them: `unavailable` (provider down, out of
quota) moves to the next, `unreachable` (the number is not a number, or is not
on this channel) stops. Telegram exhausted at eight in the evening, SMS picks
it up, nobody notices.

**Telegram is not enough on its own.** The Gateway only reaches numbers that
are on Telegram — a large minority of Indian shopkeepers, not all of them.
Before the portal is the only way in, `smsChannel` has to be real.

---

## What is a placeholder, and how to replace it

Five things. Each is one named function or one constant.

### 1. The licence signing key — `packages/core/src/config/licensing.ts`

```
npx tsx apps/portal/src/cli.ts keygen
```

Prints a `kid`, a public key and a private key. The public key goes into
`LICENCE_KEYS` in that file; the private key goes into `SHOPOS_LICENCE_KEY` in
the portal's environment and into two backups, and nowhere else. A build that
could sign a licence is a build that can mint itself one.

**Run it directly, not as `npm run portal -- keygen`.** npm parses every
unrecognised `--flag` as one of its own settings and drops it, keeping the
value behind it, so `issue --shop <id> --tier cloud` arrives as
`issue <id> cloud` and the CLI reports the argument you just typed as missing.
It survives from a POSIX shell and not from PowerShell, which is worse than a
consistent failure would be.

`LICENCE_KEYS` now carries a real key. Empty was the honest placeholder before
it did — verification returned `NOT_CONFIGURED`, which names the actual
problem, where a fake 32 bytes would return `BAD_SIGNATURE` and send somebody
looking for an attacker.

There is a third way to get this wrong and it is the one that happened: the
updater's minisign key pasted into `LICENCE_KEYS`. Both are keypairs, both
print base64, and both call the field a public key. The tell is the length —
32 bytes for Ed25519, 114 for minisign — and the symptom is a build that
answers `licensingConfigured() = true` while refusing every genuine licence
with `NOT_CONFIGURED`. `licencePlaceholders.test.ts` now checks the byte count
and calls `importKey`, because a string in the right place is not the right
string.

### 2. `PORTAL_BASE_URL` — same file

Null until there is a domain. Every caller treats null as "there is no
portal", which is the same code path as "the portal is unreachable" — a shop
on a dead line — and so is already the tested path rather than a new one.

### 3. The updater — `apps/pos/src-tauri/updater.example.json`

`tauri-plugin-updater` is not a dependency and `tauri.conf.json` has no
`plugins.updater` section, because neither the updater keypair nor the GitHub
owner/repo has been decided (rows 2 and 3 of *Left that is not code* in
`progress.md`). The example file has the block to merge and the six steps, in
order. Step 6 is one line at the call site.

Everything around the plugin is real and tested: the state machine, the
once-a-day check, the progress reporting, the words in the sidebar, and the
rule that **an install waits for the drawer to close** — downloading is always
allowed, because the download is the slow part and should happen across the
afternoon so the install at closing time is instant.

There is deliberately no forced update. A till that must update to keep
working is a till that stops working when the update server is down.

### 4. SMS — `smsChannel()` in `apps/portal/src/otp/channels.ts`

The work is not the HTTP call. Since 2021 every commercial sender in India
must register an entity and each message template on a telecom operator's DLT
portal, and unregistered traffic is dropped rather than bounced. Register the
template *before* writing the code, because the approved text is what the
function must send. Budget weeks.

### 5. OAuth — `googleOAuth()` in `apps/portal/src/auth/oauth.ts`

Three decisions are already made and encoded:

- **Identities are rows, not columns.** One owner can sign in by phone on
  Monday and by Google on Tuesday and be one account.
- **An email is not an identity.** An OAuth login whose email matches an
  existing account does not merge into it. Linking is something a signed-in
  owner does on purpose, through `linkIdentity`. Providers have been talked
  into asserting somebody else's email address more than once.
- **PKCE always**, even for a confidential client.

---

## Cloud in the loop

`apps/portal/test/licenceInTheLoop.test.ts` is the test that matters.

Every other licence test could pass against a signer that signs nothing and a
verifier that checks nothing, because both halves would be the test's own.
There, the portal mints with a real Ed25519 private key, the token crosses a
real HTTP socket, and `packages/core` verifies it with the public half exactly
as a shop's build would. A change that breaks the wire format on either side
fails there and only there.

It covers: mint → serve → install → entitle; the `X-ShopOS-Device` header
being recorded; a licence for another shop refused and *not stored*; a tier
edited by hand caught by the signature; a key rotation reported as
`UNKNOWN_KEY` and the same `kid` with a different key reported as
`BAD_SIGNATURE`; active → grace → lapsed across real dates; and **a real bill
rung up and submitted on a till whose licence lapsed six months ago**.

`routes.test.ts` runs the same service over an ephemeral port — a body that
never arrives, a header case that does not match, a 204 with no body, a
response that is not JSON. `signIn.test.ts` pins every OTP rule above.

---

## The portal's own database

`CLAUDE.md` requires a numbered `.sql` file, an entry in `migrations.ts` and
an additive/breaking classification for every migration. The portal does not
follow that, on purpose.

Those rules exist because a shop's database is replicated between tills that
update at different times, and a till on either side of a breaking change has
to know not to sync. None of that is true of the portal: there is one, the
vendor runs it, it talks to no copy of itself, and it can be stopped for a
minute. So it gets an ordered list of statements and `user_version`, applied
at boot.

Written down because it is a judgement and not an oversight. If the portal
ever becomes two portals, that paragraph stops being true and the shop's rules
start applying.

---

## Configuration

Every secret is unset by default, and **every unset secret disables its
feature rather than weakening it.** No signing key: the issuing route answers
503. No admin token: the route is not there at all, 404 rather than 401, so it
does not advertise that a secret would open it. No Telegram token: that
channel reports itself unavailable and the chain moves on.

| Variable | Default | What |
|---|---|---|
| `SHOPOS_PORTAL_DB` | `portal.db` | the portal's SQLite file |
| `SHOPOS_LICENCE_KEY` | unset | Ed25519 private key, base64url PKCS#8 |
| `SHOPOS_LICENCE_KID` | `shopos-dev` | which key that is |
| `SHOPOS_ADMIN_TOKEN` | unset | shared secret for `POST /v1/licences` |
| `SHOPOS_TELEGRAM_TOKEN` | unset | Telegram Gateway token |
| `SHOPOS_OTP_CHANNELS` | `console` | comma-separated, tried in order |
| `SHOPOS_EXPOSE_CODES` | unset | `1` returns OTP codes in the response |

`SHOPOS_EXPOSE_CODES` is the one that can hurt. `fromEnvironment` refuses to
honour it when a real channel is configured, and says so on stderr, so it
cannot be left on by accident in something that is actually delivering codes.

---

## Routes

```
GET  /v1/health                 what is wired and what is a placeholder
POST /v1/auth/start             { phone } → a code is sent
POST /v1/auth/verify            { challengeId, code } → a session token
POST /v1/auth/sign-out          always 204
GET  /v1/me                     the signed-in account
GET  /v1/licence/:shopId        the shop's current licence; records X-ShopOS-Device
POST /v1/licences               issue one (admin token)
GET  /v1/shops/:id/tills        counters seen in the last 30 days (owner only)
```

No framework and no dependency: eight routes, and `handle` is a function from
request to response that the tests call directly. `server.ts` binds it to
`node:http` and is the only file that would change to put it somewhere else.

No CORS header at all, deliberately — add one when `apps/phone` exists and
knows its own origin.

---

## What is still open

- The three owner decisions in `progress.md`: the OV certificate, the updater
  keypair, the GitHub owner/repo. None of this code is blocked on them; the
  signed release is.
- `smsChannel` before the portal is the only way in.
- No admin UI. Licences are issued by CLI or by the admin-token route.
- The portal has no account → shop linkage flow yet; `shops.account_id` exists
  and `GET /v1/shops/:id/tills` reads it, but nothing writes it except a test.
  That is Phase 6's `POST /v1/shops/:id/cloud`.
- `PORTAL_BASE_URL` has no call sites. Nothing in the till ever fetches
  `GET /v1/licence/:shopId`, so copy-paste is the only way a licence travels.
  That is not an oversight waiting to be tidied: a till reaching the portal is
  blocked by the same two things as the cloud tier — the path allowlist at
  `sync_client.rs:39`, and `crates/shopos-net` having no TLS at all. It
  unblocks with Phase 6 Stage 5 and not before.
- The OAuth helpers — `beginOAuth`, `linkIdentity`, `accountForIdentity` — have
  no routes. The seam is built and nothing calls through it.
