# Online orders: state, tests and rollout to a second shop

Written 29 Oct 2026, after the work of 27–29 Oct. For the owner, to decide
whether and how to give this to a second shop by targeted update.

## 1. In one paragraph

Everything below is built, tested and running on TRT's Till 1, the live site
(shop.thiruvengadam.me) and the Android app. None of it is committed or
released: the tills here are local builds, and the version number is still
0.5.0, the same as the tag already out. Before a second shop can have it, the
work has to be committed and released as a new version (0.6.0). That release
contains a migration (082) that stops tills on either side of it from syncing
with each other, so every till in a shop has to take it together. And the
online shop itself (website, app, tunnel, Cloudflare storage) is built for TRT
alone: a second shop gets the till features by update, but its own storefront
needs a setup of its own, described in section 6.

## 2. What was built

### For every shop (not behind the online-orders switch)

| Change | What a shop notices |
|---|---|
| A credit limit of ₹0 now means **no credit** (migration 082) | Customers already on ₹0 are moved to "No limit" on update, so nobody is refused who was allowed before. New customers start on ₹0 with "Block", so they get no credit until given a limit or "No limit". The customer form's choice reads "Up to the limit, then block / then warn / No limit". Lists show "no credit", "no limit" or the amount. The counter says "This customer is not given credit…" |
| "Over limit" counts | A customer on "no credit" who owes anything is counted over limit (Credit page, discrepancies). |
| Port messages | When a port the till needs is taken, the till names the program holding it (Settings, Online orders; the log for sync). |
| `tools/windows/setup-ports.ps1` | One-time PC setup: random-port pool kept clear of 7801–7802, firewall rules (Private networks only), optional start at sign-in. Run by hand, as administrator. |

### Only for shops listed for online orders (`ONLINE_ORDER_SHOPS`, today `01a122eb`)

Till:
- Settings, Online orders:
  - Prices on request (quotation).
  - Show quantity prices online.
  - Contact and WhatsApp switches, with the WhatsApp number.
  - Publish items now.
  - Start this till with Windows.
  - Tunnel status.
- Orders, Online: turn away with a message; change and send back; send quotation; take changes back; phone checked with customer, which now links the account to the existing customer with that number.
- Item photo: crop preview ("How customers see it"), adjust crop, the original kept.
- The main till runs the Cloudflare tunnel itself, restarts it if it dies, and stops it on close.
- The main till uploads the shop's public side (status, item list, photos) to Cloudflare when anything changes, so it is there with the till off.

Storefront (website, installed PWA, Android app):
- Layout and look:
  - The design in the style of the old app, with rounded corners.
  - Quick view, item page, quick add from grid and list.
  - Unit on every item, MRP struck through.
  - Type a quantity in the cart.
- Prices and offers:
  - Quantity prices with "add N more to save".
  - Prices on request: no prices shown, "Ask for a quotation", accept or cancel the shop's quotation.
- Orders: the review box for a changed order.
- Contact and WhatsApp: a contact card, a WhatsApp button, send cart on WhatsApp.
- Shop states and the saved copy:
  - With the till off, "Closed now · open <hours>" from Cloudflare's copy, instead of "Can't reach the shop".
  - The account kept on the phone, with no flash of the sign-in page on reload.
  - Refresh saved copy.
- Android app: native Google sign-in; back button and edge swipe go back.

## 3. Tests

Run on 29 Oct, all green:

| Suite | Result |
|---|---|
| `npm test` (core, till, portal, storefront, both benches) | 3,095 tests in 281 files, all pass |
| `npm run typecheck` (all seven projects) | clean |
| Till, Rust (`cargo test`) | 195 pass, 2 ignored (as before) |
| Network crate (`crates/shopos-net`) | 52 pass |

Added in this round, beyond what each feature already had:

| Area | Tests | What they hold to |
|---|---|---|
| Credit at the counter (`billing.test.ts`) | 5 | ₹0 + block refuses any credit; still takes cash; ₹0 + warn lets it through; No limit takes any amount; a new customer gets no credit |
| Migration 082 (`zeroCreditMigration.test.ts`) | 5 | ₹0 customers become No limit; real limits untouched; nothing fed to sync; exactly one revision bump; it is breaking |
| Online core (`webOrders.test.ts`, 37 → 46) | 9 | Uploaded status is the live status; closed when off or switched off; list renamed only on a visible change; quotations hide quantity prices and MRP; same items listed; quotation turned down cancels; cannot accept while a quotation waits; prices return when switched off; phone check with no match links nobody |
| Storefront, where it reads from (`api.test.ts`) | 11 | Open, closed, closed-now-from-Cloudflare, unreachable, offline, offline without asking; list from Cloudflare, else the till; refresh bypasses the edge copy; photos from Cloudflare |
| Cloudflare function (`dataFunction.test.ts`) | 8 | Each of the four routes; old list name refused; photo type; not found before the first upload and never cached; anything else refused; second ask served from the edge cache |
| Till uploader (`cloudShop.test.ts`) | 7 | Status, photos, then list; nothing twice; status alone when only it changed; only new photos; a failed photo holds the list back and is retried; nothing without a key; overlapping calls fold into one |
| Counter message (`creditMessage.test.ts`) | 2 | "Not given credit" at ₹0; "over by ₹…" otherwise |
| Rust | 8 | Tunnel restarted when it exits, and says why; missing cloudflared reported; keeper stops when asked; Cloudflare key file needs all three keys; only plain keys reach Cloudflare; shortcut found however its path is stored; another till's shortcut not mistaken |

Two real faults the new tests found, both fixed:
1. The Cloudflare function answered a photo for `/data/img/<hash>/anything`. It now accepts exact paths only.
2. "Start this till with Windows" could miss the setup script's shortcut when Windows stored the path on an odd byte. The switch then showed off while the till still started, and switching it off left the shortcut. Fixed and tested on both alignments.

Checked live, not only in tests:
- The tunnel was killed while Till 1 ran, and the till brought it back within 20 seconds.
- With Till 1 off, the site served the shop's status, 20 items with prices, and photos from Cloudflare.
- Wrong paths on the live function return 404.
- Migration 082 ran on Till 1. Walk-in and RAMAKRISHNAN J moved to No limit; others unchanged.

Not checked yet:
- Sleep and wake of the main PC (the tunnel should reconnect).
- Google sign-in in the Android app since the scopes fix, and the back gesture, on a real phone.
- A full quotation loop on a phone.
- Load on order placing. Only read requests were load-tested: about 200 status checks a second, and more than 8 at the same instant are cut off.
- Anything on a second shop's PC.

## 4. What a second shop gets by targeted update

### If its id is not added to `ONLINE_ORDER_SHOPS`

It gets only the "every shop" row of section 2:
- the credit change (082), with its customers on ₹0 moved to No limit;
- the port messages.

None of the online screens, the tunnel, the uploads, the photo crop, or the "Start with Windows" switch. That switch sits in Settings, Online orders, which such a shop never sees; it can still start at sign-in through `setup-ports.ps1 -StartTill`.

### If its id is added

It gets the till side of everything in section 2. It does not get a working online shop until section 6 is done for it: the storefront, the domain, the tunnel and the Cloudflare storage are TRT's.

## 5. What a shop gives up or must watch with this release

1. **Tills stop syncing until all are updated.** Migration 082 is breaking, so a till on 0.5.x cannot sync with one on 0.6.0. A till left behind keeps billing on its own (the counter never stops), and its bills sync once it updates. Update every till in the shop the same day. A targeted release reaches tills as each one checks for updates, so expect a gap of hours unless someone opens each till.
2. **New customers get no credit by default.** Before, a customer left at ₹0 could buy anything on credit. Now:
   - a customer made at the counter, from an online order, or by import with a blank or 0 limit is "no credit" until someone sets a limit or No limit;
   - cashiers will meet "This customer is not given credit" where they did not before;
   - **customer import:** a spreadsheet with `creditlimit` 0 used to mean unlimited and now means none.
3. **Changing the main till is a person's job, not automatic.** This is the "no till change" cost. Three things live only on the main PC and do not travel by sync:
   - The tunnel's files (`%USERPROFILE%\.cloudflared\config-shopos.yml` and its credentials). Copy them to the new main, or create a new connector for the same tunnel.
   - The Cloudflare key (`%USERPROFILE%\.shopos\cloudflare.env`). Copy it, or uploads stop and phones keep the last uploaded copy.
   - Item photo files. Rows sync and bytes do not, so photos added on the old main stay on its disk. Photos already uploaded keep showing from Cloudflare; new photos must be added on the new main.

   Also:
   - Customers sign in again: the session secret is per till by design.
   - "Start this till with Windows" is set per PC.
   - The old main must stop answering. Only one main, per `one-main-till.md`.
4. **Online needs the main till's PC.** Orders, sign-in and order status need Till 1 on and awake. Browsing, prices, photos and contact do not. "Start this till with Windows" only works after someone signs in to Windows; for a PC that restarts unattended, set Windows to sign in by itself.
5. **Cloudflare limits (free plan).**
   - Writes: 1,000 a day. Uploads happen only on change, at most every 3 minutes, so the worst case is about 500.
   - Reads: 100,000 function calls a day, and each photo shown is one. A shop with heavy traffic and many photos could reach it; the paid plan is $5 a month.
   - Spreading: a change can take up to a minute to reach every phone.
6. **The Cloudflare token sits in a plain file** on the main PC, and anyone using that PC's Windows account can read it. It can edit Workers KV and R2 on the whole account; narrowing it to KV only, and to one namespace if the dashboard allows, is advised. The copy in `apps/pos/src-tauri/.env` is not used by the build and can be removed.
7. **Under heavy load a busy till can look closed.** If the till cuts a status check off (more than 8 at the same instant), the phone reads Cloudflare's copy and shows "Closed now" until its next check, a minute later. Rare at a shop's traffic; worth knowing.
8. **Quotations use the till's prices.** There is no typing a special price into a quotation yet.

## 6. Giving a second shop its own online shop

Code changes, small:
- Add its id to `ONLINE_ORDER_SHOPS` (`packages/core/src/services/web/gate.ts`) and to the release's `shops:` line.
- `mobile/storefront/ship.mjs` and `apps/storefront/wrangler.toml` name TRT's Pages project and KV store. A second shop needs its own pair (a second toml, or a shop argument to `ship.mjs`).
- The Android app id (`me.thiruvengadam.storefront`) and the name "StoreFront by TRT" are TRT's. A second app needs its own id, name, icon and signing key.

Setup, per shop (about an hour, most of it in dashboards):
1. **Domain:** two subdomains, for the shop and for its API.
2. **Tunnel:** run `cloudflared tunnel create`, route the API subdomain, and write `config-shopos.yml` pointing at `127.0.0.1:7802` on its main PC.
3. **Website:** a Pages project with the shop subdomain, and a KV namespace bound to it.
4. **Cloudflare key:** an API token, saved in `%USERPROFILE%\.shopos\cloudflare.env` on its main PC.
5. **Google sign-in:** a web OAuth client (origin = its shop subdomain) and an Android client (its app id and SHA-1). Paste the web client id into Settings, Online orders.
6. **Build:** the storefront with `SHOP_API` and `SHOP_DATA` set to its addresses, then the APK.
7. **The main PC:**
   - run `setup-ports.ps1 -StartTill` on it;
   - set its wifi to Private;
   - turn on "Start this till with Windows";
   - choose the listed categories, and turn online orders on.

## 7. Before releasing

1. Commit the work. Nothing is committed: 54 files changed and 86 new, most of the new ones the Android project and the storefront fonts.
2. Raise the version to 0.6.0 (`apps/pos/package.json`), and tag `v0.6.0` from `phase-2-foundations`.
   - The tag message's `shops:` line names the shops, for example `shops: 01a122eb,<second>`.
3. Publish the draft. Then open every till of each target shop the same day (section 5.1).
4. If the second shop gets online orders, do section 6 first. Its tills can run the new version before its storefront exists: online stays off until it is switched on.
5. Tell its cashiers about "no credit" for new customers (section 5.2), and check its customers on ₹0 after the update. They will show "No limit".

## 8. Still open

- The second shop's id.
- Order emails, and push notifications ("your order is ready" is WhatsApp by hand).
- The sync gap for new tables.
- Auto-listing new categories online.
- Typing special prices into a quotation.
- Making a busy till look busy rather than closed (section 5.7).
- The checks listed in section 3 as not yet done.
