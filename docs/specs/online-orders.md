# Online orders

A storefront for a shop's own customers: they browse its items on their phone,
order, and collect and pay at the counter. Built 27–28 Oct 2026 for two shops
only (`ONLINE_ORDER_SHOPS` in `packages/core/src/services/web/gate.ts`):
`01a122eb` and one more still to be added.

## The shape

```
phone ── shop.<domain> (Cloudflare Pages: apps/storefront, a PWA)
   │
   └── api-shop.<domain> ── Cloudflare (TLS, caches /catalog and /img)
                               │ tunnel: cloudflared, a Windows service on the main PC
              127.0.0.1:7802   web_server.rs (crates/shopos-net/src/web.rs)
                               │ "web-request" → core/webHost.ts → handleWebRequest
                            shop.db ── sync ── the shop's other tills
```

- **The main till is the only server.** No VPS, no Supabase. When it is off,
  the storefront says the shop cannot be reached; browsing goes on from the
  copy kept on the phone.
- **Only the main answers** (`whyNotServing`): the shop is listed, Settings →
  Online orders is on, and this till is the main (or alone). It can also be
  switched off from the portal (`online_orders` on the switch board).
- **An order is a request until a person accepts it.** Accepting raises an
  ordinary sales order, priced by the till, so any counter can bill it with
  "Bill it". The customer sees it collected once every line is billed. Nothing
  is set aside on the shelf; whoever accepts checks the shelf first. The Online
  view shows on-hand stock against each line.
- **Customers sign in with Google.** The main checks Google's signed token
  itself (`google.ts`) and issues its own 30-day session. The phone number is
  only what was typed until a cashier ticks "Phone checked with customer" on
  the order. Until then it never links the account to an existing customer, so
  typing someone else's number never gets their price list or khata.
- **Items without a photo** are listed under Settings → Online orders.
- **Photos** are added on the main (Inventory → item → Photo for the
  storefront). The till shrinks each one to 600 px and 200 px WebP. The files
  stay on the main; only the row travels.

## Caching

| What | Where | Rule |
|---|---|---|
| The app | Cloudflare Pages + service worker | hashed files kept for ever; the page network-first with a 3 s fallback |
| `/catalog/manifest.json` | Cloudflare edge | `s-maxage=60`: the main builds the catalogue about once a minute, however many browse |
| `/catalog/<sha256>.json` | edge + IndexedDB on the phone | immutable, named by its content |
| `/img/<sha256>` | edge + service worker (newest ~300) | immutable |
| `/api/*` | nowhere | `no-store` |

## One-time setup

1. **Google.** In Google Cloud console create an OAuth client of type *Web
   application*. Add `https://shop.<domain>` as an authorised JavaScript
   origin. Copy the client id.
2. **Settings → Online orders** on the main till:
   - turn it on;
   - tick the categories to list;
   - set the storefront address `https://shop.<domain>`;
   - paste the Google client id.
3. **The tunnel**, on the main PC (download `cloudflared` for Windows from
   Cloudflare), run:
   ```
   cloudflared tunnel login
   cloudflared tunnel create shopos-web
   cloudflared tunnel route dns shopos-web api-shop.<domain>
   ```
   Then write `%USERPROFILE%\.cloudflared\config.yml`:
   ```yaml
   tunnel: shopos-web
   credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
   ingress:
     - hostname: api-shop.<domain>
       service: http://127.0.0.1:7802
     - service: http_status:404
   ```
   and install it as a service: `cloudflared service install`.
4. **Cloudflare cache rule** on the zone: when hostname is `api-shop.<domain>`
   and the path starts with `/catalog/` or `/img/`, mark it *Eligible for
   cache* and respect origin headers. Cloudflare does not cache JSON otherwise.
5. **The storefront.** Build with
   `SHOP_API=https://api-shop.<domain> npm run storefront:build`, then drag
   `apps/storefront/dist` into a Cloudflare Pages project with the custom
   domain `shop.<domain>`. Upload it again after any change; phones pick it up
   on their next open.

To try it without a domain:
- run `cloudflared tunnel --url http://127.0.0.1:7802` for a temporary
  address;
- run `npm run storefront:dev` with `SHOP_API` set to that address.

## Releasing

- Targeted to the two shops: `RELEASE_FIRST_SHOPS=01a122eb,<second>`.
- The website download stays pinned (`site/index.html`).
- The code is in every build. It does nothing in a shop not listed in
  `ONLINE_ORDER_SHOPS`, so widening a release later is safe.
- Migration 080 is additive.

## Not done yet

- Taking a photo with a phone straight into an item.
- Web push for "ready" (the Online view has a WhatsApp button instead).
- Copying photo files to other tills.
- A Play Store app.
- The storefront's icon is a plain shopping bag. Put the shop's own in
  `apps/storefront/public/` as `icon.png` (128 px), `icon-192.png` and
  `icon-512.png`, and change `name` in `manifest.webmanifest`.
