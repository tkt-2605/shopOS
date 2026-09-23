# Billing — charging shops, without a payment gateway

Phase 4½. Lives in `apps/portal` beside accounts and licences, because it is the
same service, the same owner account and the same database.

**Not GST billing at the counter.** That is `services/billing.ts` and has
nothing to do with this. This is the vendor invoicing shops for ShopOS.

---

## The rule that outranks the rest

**Billing decides what `paidThrough` should be. The licence merely states it.**

They are separate systems that meet at one field, and keeping them separate is
what preserves the product's first rule. A failed payment does not reach into a
till and switch anything off — it means the *next* token is not issued. A shop
whose UPI mandate bounced on Tuesday is still holding a signed licence valid
until its date, and goes on billing customers exactly as before.

So there is no remote kill switch, no "phone home or stop working", and nothing
in `packages/core` learns the word *subscription*. The enforcement points are
already built and already tested: `paidThrough`, thirty days of grace, and four
gated features that a single-till shop does not use.

---

## Manual first, and that is not a compromise

A payment provider costs KYC paperwork, a percentage, and weeks of integration —
to solve a problem that does not exist below about thirty shops.

The first shops pay by UPI to a VPA you already have. You see the notification.
You record it in the portal. The portal issues a licence with a new
`paidThrough` and the till picks it up on its next check. That is a complete
billing system, it works today, and it costs nothing.

```ts
interface PaymentProvider {
  readonly name: string
  /** A payment that has already happened. Manual providers only record. */
  record(input: RecordPayment): Promise<Recorded>
  /** Where to send somebody to pay. Null when there is nowhere to send them. */
  checkoutUrl?(input: Checkout): Promise<string | null>
  /** Verify a provider callback. Absent on manual. */
  verifyWebhook?(raw: string, signature: string): Promise<Recorded | null>
}
```

| Provider | State |
|---|---|
| `manualUpi` | **real.** You record a transfer you have already received |
| `razorpay` | **placeholder.** Needs KYC, ~2% + GST, and e-mandate approval for UPI Autopay |
| `bankTransfer` | **real.** Same as manual, different words on the invoice |

The same seam shape as `OtpChannel` in `apps/portal/src/otp/channel.ts`, and for
the same reason: the provider changes for reasons that have nothing to do with
this product, and that must not reach the part that decides whether a shop is
paid up.

**A manual payment is not a lesser payment.** It produces the same
`payments` row, the same invoice and the same licence. Swapping in Razorpay
later changes who calls `record()` and nothing downstream.

---

## What is sold

| Tier | What it adds | Suggested |
|---|---|---|
| *no licence* | one counter: the whole till, GST, stock, credit, reports, backups | free |
| `single` | nothing over the free tier yet. A paid customer on one counter | ₹W / year |
| `multi` | **adding** more counters, and LAN sync between them | ₹X / year |
| `cloud` | off-site replica, phone view, diagnostics upload | ₹Y / year |
| `branches` | per-branch stock and transfers | ₹Z / year |

The tiers are a ladder, so `cloud` includes `multi`. A shop paying to keep its
books off-site certainly has more than one counter, and charging twice for that
reads as sharp practice.

### Two clocks, and why a shop holds more than one code

**`multi` is bought once. `cloud` recurs.** That is not a pricing whim, it is
the old rule about where the vendor's costs are: a second counter is peer to
peer on the shop's own wire and costs nothing to keep running, so it is sold
outright and issued with `paidThrough: null`. The cloud costs money every
month, so it is a subscription with a date.

One token cannot say both — it carries one `tier` and one `paidThrough`. Held
in one token, a shop that bought the counter outright and later let its cloud
subscription lapse **lost the counter it had paid for**, because a lapsed token
allows nothing whatever its tier. That is the kind of thing a shopkeeper tells
other shopkeepers about.

So a till holds a *set* of codes and entitlement is the union — `allowsAny` in
`domain/licence.ts`. A lapsed code contributes nothing and takes nothing away.
`twoClocks.test.ts` holds it, and the test that matters is `keeps what was
bought outright when the subscription lapses`.

Practically, at the CLI:

```
# sold once, never expires
npx tsx apps/portal/src/cli.ts issue --shop <id> --tier multi

# renewed every year
npx tsx apps/portal/src/cli.ts issue --shop <id> --tier cloud --paid-through 2027-03-31
```

Two codes, both pasted, both kept. Pasting a second `cloud` code replaces the
first, because that is what a renewal is; pasting a `multi` code beside it
leaves both.

**The free tier is the absence of a code, not a code that says `single`.** No
licence means `state: 'none'`, which already refuses every gated feature — so
free users need nothing issued, nothing supported and nothing renewed. `single`
exists for the shop that pays for one counter, which mostly means a shop that
wants an invoice from you.

**`multi` gates the introduction, never the conversation.** Tills already
paired go on syncing through a lapse, through a removed code, for ever. That is
held by `multiTillGate.test.ts` and the reasoning is above `GATED` in
`domain/licence.ts`: billing never stops, so a lapse that stopped sync would
leave a shop taking money on two counters that no longer merged, with nothing
on either screen to say so. What a shop bought, it keeps.

**Yearly, not monthly.** Three reasons: a kirana shop thinks about software the
way it thinks about a shop licence renewal; one collection a year beats twelve
chances for a mandate to fail; and monthly recurring in India means e-mandates,
which means Razorpay, which is the thing being deferred. Offer monthly when a
shop asks and take the extra collection effort as the cost of the sale.

Prices are a `plans` row, not a constant. A shop that signed at one price keeps
it at renewal unless somebody deliberately moves them — so a subscription points
at the plan version it was sold under.

---

## Tables, in `portal.db`

Appended to `SCHEMA` in `apps/portal/src/store.ts`; its header says why the
portal uses an ordered list and `user_version` rather than the shop's numbered
migrations.

```sql
plans (id, tier, period, amount_paise, gst_rate_bp, active, created_at)

subscriptions (
  id, shop_id, plan_id, status,          -- trialing|active|past_due|cancelled
  started_at, current_period_end,        -- this is what becomes paidThrough
  cancel_at, cancelled_at, note
)

payments (
  id, subscription_id, amount_paise, provider, provider_ref,
  received_at, recorded_by, note         -- recorded_by: an account id, or 'cli'
)

invoices (
  id, invoice_no, subscription_id, payment_id,
  shop_gstin, shop_state_code, place_of_supply,
  taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
  issued_at, pdf_path
)
```

`payments` is append-only and a refund is a negative row, never an edit — the
same rule the shop's own ledgers follow, for the same reason.

`current_period_end` is the single field billing owns and licensing reads.
Issuing a licence is `paidThrough = subscriptions.current_period_end`, and
nothing else in the system is allowed to compute it.

---

## The vendor needs GST invoices too — and already has the code

Fitting, and useful: a product that exists to get Rule 46 right on a shop's
invoices is sold by a business that has to get Rule 46 right on its own.

What is reusable almost as-is:

- `packages/core/src/domain/invoiceHtml.ts` — the renderer
- `packages/core/src/domain/gstin.ts`, `domain/states.ts` — validation, and
  which state a GSTIN belongs to
- the place-of-supply rule from Phase 1b — **your state vs the shop's state
  decides CGST+SGST against IGST**, and a shop in another state is the common
  case, not the edge case
- `rule46.test.ts` — the rule as a checklist, asserted by text
- `services/numbering.ts` — a document series with a fiscal-year tag

What is different and must not be copied blindly:

- **SAC, not HSN.** This is a service. The code for licensing the right to use
  software sits under SAC 9973 — **confirm the exact sub-code with a CA**, do
  not take it from this file.
- **18% is the rate** for software licensing, at the time of writing.
- **Below the registration threshold you charge nothing.** Aggregate turnover
  under ₹20 lakh for services (₹10 lakh in some special-category states) means
  no GST registration and no GST on your invoices — and the invoice must then
  *not* look like a tax invoice. This is exactly the `unregistered` tax scheme
  the till already implements, pointed at yourself.
- **A registered shop wants your GSTIN on the invoice** so it can claim input
  credit. That is a selling point worth making out loud, and it means
  `shop_gstin` is worth collecting even from shops on the `single` tier.

Tax rules change. Every number in this section is a starting point for a
conversation with an accountant, not an authority.

---

## Renewal, which is already built

`GET /v1/licence/:shopId` exists and serves the most recent licence issued to a
shop (`apps/portal/src/licences.ts`). So renewal is:

1. payment recorded → `current_period_end` moves
2. portal issues a new token with the new `paidThrough`
3. the till fetches it and installs it

**Step 3 is the one piece missing**, and it is small: a periodic licence refresh
in the app that calls the route, runs `installToken` if the token is newer, and
treats every failure as nothing at all. It belongs behind `PORTAL_BASE_URL`
being non-null, so a build with no portal never tries.

No shop action. The shopkeeper pays and the till quietly stops counting down.

---

## Dunning — saying it, not enforcing it

Reminders at `-14 days`, `-1 day`, `+1 day` and `grace -7 days`, through the
same channel seam the OTP uses. Each one is a sentence naming a date and an
amount, never a threat.

The escalation is already designed and needs no new code:

```
current_period_end
  │  active
  ▼
+0    grace begins — everything still works, thirty days
  │
  ▼
+30   lapsed — the four gated features stop
      billing does not. LAN sync does not. Backups do not.
      Nothing is un-paired.
```

Thirty days of grace is in `packages/core/src/domain/licence.ts` with its
reasoning: the month a renewal is late is the month money was tight, and taking
a shop's off-site backup away in that particular month is both the cruellest
timing available and the one most likely to lose somebody's books.

---

## Routes

```
POST /v1/shops/:id/subscription      start or change one          (owner)
GET  /v1/shops/:id/subscription      status, next date, amount    (owner)
POST /v1/payments                    record one, issue the token  (admin)
GET  /v1/invoices/:id                the GST invoice              (owner)
POST /v1/webhooks/:provider          placeholder, disabled unset  (provider)
```

`POST /v1/payments` is the one that matters and is the one you will use daily.
It records the money, moves `current_period_end`, issues the licence and
generates the invoice **in one transaction** — because a payment recorded
without a licence issued is a shop that paid and did not get what it paid for,
and that is the failure that ends a relationship.

Admin auth follows `apps/portal/src/config.ts`: a shared secret, and unset
disables the route entirely rather than weakening it.

---

## The CLI matters more than the routes at first

```
npx tsx apps/portal/src/cli.ts pay --shop <id> --amount 500000 --ref <upi-ref>
```

One command: records the payment, extends the period, issues the licence, prints
the token and the invoice path. For the first thirty shops this is the whole
billing system, run from a laptop, and it needs no server to be reachable by
anybody.

---

## What is deliberately not built

| Not now | Why |
|---|---|
| Razorpay, UPI Autopay | KYC, ~2%, e-mandate approval. Worth it past ~30 shops; a tax before that. |
| Proration | Yearly plans and tier changes at renewal make it unnecessary. Handle the rare mid-year upgrade by hand and write a note on the payment. |
| A self-serve checkout page | A shopkeeper buying retail software in India wants to talk to a person. The portal is for the owner to see status, not for a stranger to buy. |
| Trials in code | `status: 'trialing'` exists in the schema; issue a short-dated licence by CLI and let it lapse. |
| Dunning emails | The channel seam exists; the sentences do not. Write them when there is a shop to send one to. |
| Anything that touches a till | There is no remote kill switch, and adding one would break the rule at the top of this file. |

---

## Risk worth naming

**`portal.db` on a laptop is the only record of what you have sold.** Not the
licences — those are signed and reproducible — but who paid, when, and what they
were promised. Back it up from the first sale, not the tenth. A `pull-shop-db`
equivalent for the portal is an afternoon and is worth it before there is
anything to lose.
