# Phase 1 spec — The bills have to be right

Source: plan *Phase 1* (1a–1d) and architect pass *Also found to be guesses*.
Written as bookkeeper first, engineer second: every item names the rule it
serves, because the rule is what a builder should read when a test is
ambiguous.

## Scope

Make the stored bill, the printed paper and the GST export agree with the CGST
Rules and with each other, for every kind of shop the product sells to. Then
wire or remove every switch found on and doing nothing. This phase is the
largest and the one with the least tolerance for "close enough".

## Open decisions resolved here

- **Snapshot the invoice** (migration 028). `bills` gains `supply_type`,
  `customer_gstin`, `customer_address`, `customer_state_code`, `reverse_charge`.
  Written at submit, read by every renderer and report, never by a live join to
  `customers`. This is rule 4 applied to what the paper said.
- **Tax scheme is a shop setting.** `shop_tax_scheme ∈ {regular, composition,
  unregistered}`. Under `regular` nothing changes. Under the other two the till
  charges no tax (line taxable = line total, tax 0; product rates are kept for
  the day the shop registers), the document is titled *Bill of Supply*
  (composition, with the Rule 49 statement "composition taxable person, not
  eligible to collect tax on supplies") or *Invoice* (unregistered), and the
  GST tabs are hidden with a sentence saying why. Default on upgrade:
  `regular` if a GSTIN is set, otherwise `unregistered`, and Settings asks on
  the first open after the migration.
- **Rule 46(f)** — a bill of ₹50,000 or more with no named customer is refused
  with `NEEDS_RECIPIENT`; the screen opens the customer form with state
  required. A required field, not a stopped till.
- **Section 34(2)** — a return against a bill whose fiscal year has ended and
  whose following 30 November has passed gets a warning on the return screen
  and `late_credit_note` in the audit row. Never blocked.
- **HSN** — when present must be 4, 6 or 8 digits; warned on the product form,
  never blocked; the GST export appends an *exceptions* sheet of B2B lines
  missing HSN.
- **Rounding** stays a per-bill setting (`features.ts:171`); Section 170 is
  about the return, not the invoice. `gstLines.total` includes `round_off` so
  the export ties to `grand_total`.
- **Amend** gets a fresh number from the same series, as `billing.ts:496`
  already does. The cancelled bill keeps its number and appears in the
  document summary as cancelled. Under GST there is no "amended invoice"; this
  is cancel + new, and the UI wording says so.

## File-level task list

### Migration 028 — `packages/core/migrations/028_invoice_snapshot.sql`

```sql
ALTER TABLE bills ADD COLUMN supply_type TEXT CHECK (supply_type IN ('intra_state','inter_state'));
ALTER TABLE bills ADD COLUMN customer_gstin TEXT;
ALTER TABLE bills ADD COLUMN customer_address TEXT;
ALTER TABLE bills ADD COLUMN customer_state_code TEXT;
ALTER TABLE bills ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0 CHECK (reverse_charge IN (0,1));

-- Existing bills: the best evidence there is. supply_type from where the tax landed.
UPDATE bills SET supply_type = CASE
  WHEN EXISTS (SELECT 1 FROM bill_items bi WHERE bi.bill_id = bills.id AND bi.igst_amount > 0)
  THEN 'inter_state' ELSE 'intra_state' END
WHERE docstatus IN (1, 2);
UPDATE bills SET
  customer_gstin   = (SELECT gstin   FROM customers c WHERE c.id = bills.customer_id),
  customer_address = (SELECT address FROM customers c WHERE c.id = bills.customer_id)
WHERE customer_id IS NOT NULL AND docstatus IN (1, 2);
-- customer_state_code is NOT backfilled: every customers.state_code is the fabricated '33'.

UPDATE customers SET state_code = NULL;   -- plan 1a: none was ever entered by a person

ALTER TABLE sales_return_items ADD COLUMN hsn_code TEXT;
ALTER TABLE sales_return_items ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0;
UPDATE sales_return_items SET
  hsn_code    = (SELECT hsn_code    FROM bill_items bi WHERE bi.id = sales_return_items.bill_item_id),
  tax_rate_bp = (SELECT tax_rate_bp FROM bill_items bi WHERE bi.id = sales_return_items.bill_item_id);
```

Raise `EXPECTED_SCHEMA_VERSION` to 28 in the same commit. Additive under the
Phase 2c classification. `[delegate: Opus]` — run against a copy of the
owner's database before trusting it, as 027 was.

### 1a. Wrong numbers

- **Customer state**: `services/customers.ts` — add `stateCode` to create and
  update; derive from the GSTIN prefix when one is given (`shop.ts:190` does
  this for the shop; extract `stateFromGstin()` into `domain/gstin.ts` and use
  it in both); default to the shop's state. `pages/Customers.tsx` gains a
  state select from `domain/states.ts` — 37 codes with names, to be added;
  nothing has the names today and the invoice needs them. `[delegate: Opus]`
  for the service; `[delegate: Sonnet/Haiku]` for the form.
- **`amendBill` carries everything**: `billing.ts:690` — pass line
  `discount`, bill `discount`, `notes`; posting date is *today* because it is
  a new document. `[delegate: Sonnet/Haiku]` with a test asserting to the paisa.
- **Returns in the GST reports**: `repos/reports.ts` `taxByRate` and
  `gstLines` gain a `UNION ALL` over `sales_return_items` joined to
  `sales_returns` (docstatus 1) with negated amounts and the credit note's
  `doc_no`; `gstLines` rows gain `kind: 'invoice' | 'credit_note'` and
  `againstDocNo`. `[delegate: Opus]`
- **`receipt.ts:421`** — use `qty` from the line, never divide money.
  `[delegate: Sonnet/Haiku]`
- **`gstLines.total`** includes `round_off` on the last rate row of each bill
  so the rate rows sum to `grand_total`. `[delegate: Sonnet/Haiku]`
- **Returns re-derive supply type** (`returns.ts:131`): read
  `bills.supply_type` instead. `[delegate: Sonnet/Haiku]`

### 1b. What the paper must carry (Rule 46, Rule 49, Rule 53)

- `domain/receipt.ts` — `ReceiptItem` gains `hsn`, `taxRateBp`, `cgst`, `sgst`,
  `igst`; `ReceiptDoc` gains `recipient {name, address, gstin, stateName}`,
  `placeOfSupply {code, name}`, `supplyType`, `reverseCharge: false`, `title`,
  `schemeStatement?`, and `rateSummary: Array<{rateBp, taxable, cgst, sgst,
  igst}>` built from the lines. `catalog.ts:364 loadBillDetail` fills them
  from the 028 columns. `[delegate: Opus]`
- `domain/invoiceHtml.ts` — A4 layout with columns HSN · Qty · Rate · Taxable ·
  CGST · SGST · IGST · Total (IGST hidden intra-state and the pair hidden
  inter-state), the rate-wise summary block, the recipient block, "Place of
  supply: 27 — Maharashtra", "Reverse charge: No", the title per scheme, and
  an "Authorised signatory" box. `printHtml.ts:129,159` stop inventing the
  recipient and the place of supply. `[delegate: Opus]`
- Thermal receipt (`receipt.ts`): the rate summary as one line per rate; no
  per-line split, for paper width. `[delegate: Sonnet/Haiku]`
- **Credit note print**: `loadReturnDetail` + `creditNoteHtml` reusing the A4
  renderer with title *Credit Note*, the original invoice number and date
  (Rule 53(1)(e)), and the reason. A button on the Returns screen and on the
  bill's return list. `[delegate: Opus]`
- Bill title per `shop_tax_scheme`: *Tax Invoice* / *Bill of Supply* /
  *Invoice*; the `docFormat.ts:190` title element defaults **on**.
  `[delegate: Sonnet/Haiku]`

### 1c. Guards

- `submitBill`: `SHOP_STATE_UNSET` when the scheme is `regular` and
  `shop_state_code` is null; `NEEDS_RECIPIENT` per Rule 46(f). `saveShop`:
  `GSTIN_REQUIRED` when the scheme is `regular` and GSTIN is empty.
  `[delegate: Opus]`
- Customer GSTIN validated with `GSTIN_SHAPE` (moved to `domain/gstin.ts`);
  `GSTIN_STATE_MISMATCH` when it disagrees with the chosen state.
  `[delegate: Sonnet/Haiku]`
- HSN shape check in `products.ts` (warning code `HSN_SHAPE`, save allowed).
  `[delegate: Sonnet/Haiku]`
- `test/rule46.test.ts`: renders an A4 invoice for an inter-state B2B bill,
  an intra-state B2C bill, a composition bill and a credit note, and asserts
  each mandatory field is present by text, not by DOM position.
  `[delegate: Opus]`

### 1d. Switches that are on and do nothing

- **Host never syncs outbound** — `syncServer.ts:147` and `sync.ts:558
  rememberPeer` write `address` from the request's remote address and the
  port header the joiner already sends; `rememberAddress()` is called on
  every accepted inbound request so a till that moved IP is found again.
  `SyncCard.tsx:140`: "Nothing to sync with yet" when `pairedPeers()` is
  empty; "Both tills agree" only after a round that contacted the peer. Test:
  `host-initiates.test.ts` in the bench. `[delegate: Opus]`
- **Amend button** on `Bills.tsx` for cancelled bills, worded "Raise a
  corrected bill". `[delegate: Sonnet/Haiku]`
- **Retire / soft delete**, per table: `products.is_active` wired (toggle on
  the product page, hidden from counter search, kept on reports);
  `customers`, `suppliers`, `price_lists`: `deleted_at` wired with an
  "archive" action and an "archived" filter; `roles`, `users`: keep
  `deleted_at` if a disable path exists, else drop the column in the next
  migration. `deleteSupplier` becomes an archive. `[delegate: Sonnet/Haiku]`,
  one commit per table.
- **Cash-close history** — `cash.ts` gains `listSessions(range)` selecting
  the columns written at `cash.ts:148`; a `CashSessions` page under Reports,
  variance red when non-zero. `[delegate: Sonnet/Haiku]`
- **`activity_log`** — drop the table (migration), `writeActivity` and its
  types. `[delegate: Sonnet/Haiku]`
- **`changePassword`** — "Change my password" in the user menu.
  `renameCategory`/`removeCategory` — buttons on the categories editor.
  `[delegate: Sonnet/Haiku]`
- **Schema errors** — `App.tsx` startup: `instanceof SchemaTooNewError` →
  "This database was made by a newer ShopOS (schema N); update this till."
  `[delegate: Sonnet/Haiku]`
- Smaller: `loadDocument` returns `round_off`; `tax_reversed` and
  `schema_bootstrapped_at` dropped unless a grep finds a reader;
  `ACCEPTED_MIME` used by `Attachments.tsx:140`. `[delegate: Sonnet/Haiku]`
- `sync_queue` dropped in a migration. `[delegate: Sonnet/Haiku]`

## Dependencies

- Migration 028 first; everything in 1a/1b reads its columns.
- 1d's host-sync fix needs the bench's clock seam and `host-initiates.test.ts`.
- Nothing here waits for Drizzle. Do **not** start 2a until 1a–1c are merged,
  or the Drizzle swap rewrites queries that are mid-change.

## Verification

- [ ] Owner's real database: the `tools/pull-shop-db` copy migrated to 28; `integrity_check` ok; every submitted bill has `supply_type`, and those with a customer have `customer_gstin`
- [ ] Shop state set to 27 (Maharashtra) on the copy: a bill to a customer in 27 stores CGST+SGST, to one in 33 stores IGST, both asserted on `bill_items` rows
- [ ] Amend a cancelled ₹900 bill (₹1,000 less ₹100 discount): the draft is ₹900 with tax on ₹900
- [ ] A ₹500 return against a ₹1,000 bill appears in the GST export as a `credit_note` row of −₹500 against the invoice number; `taxByRate` totals drop by the same
- [ ] `rule46.test.ts` green; the A4 print of a real bill contains title, supplier GSTIN, a consecutive number of at most 16 characters, date, recipient block, HSN, qty with unit, taxable, rate, CGST/SGST or IGST, place of supply with the state name, "Reverse charge: No", signatory box
- [ ] Composition scheme on the copy: a bill stores zero tax, prints *Bill of Supply* with the Rule 49 statement, and the GST tab is hidden with its sentence
- [ ] `host-initiates.test.ts` green; on the LAN with the joiner idle, the host's Settings never says "Both tills agree" before contacting it
- [ ] Every 1d item: a screenshot or a test showing the switch doing something, attached to its commit
- [ ] Reports re-run on the owner's copy before and after: `salesSummary` unchanged; `gstLines` differs only by returns and `round_off`
