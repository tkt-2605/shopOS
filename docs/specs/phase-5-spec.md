# Phase 5 spec — What a shop does every day

Source: plan *Phase 5*. Architect pass §8 (Tamil), §9 (WhatsApp).

## Scope

The everyday backlog, in the plan's order. Most items are a screen over a
service or columns that Phase 1d already exposed, and are handed off in a
line. The few with real design content get a paragraph. Customer buckets is
done last and is the proof of Phase 2c.

## Open decisions resolved here

- **WhatsApp** ships as the share path: "Send on WhatsApp" opens
  `https://wa.me/91<phone>?text=<summary>` and saves the PDF beside it for
  the user to attach. No account, no approval, no per-message cost. The Cloud
  API is Phase 6.
- **Tamil needs shaping, not just a font.** `rustybuzz` + `ttf-parser` in
  `pdf.rs` (pure Rust), Noto Sans Tamil embedded as a CID font, the OFL text
  in the installer's licences folder. Thermal receipts draw Tamil lines as a
  raster strip via the ESC/POS bit-image command, because the printers have
  no Tamil code page.
- **Weight-embedded barcodes**: EAN-13 with prefix `2x`, layout chosen per
  shop (`prefix(2) item(5) weight(5) check(1)` as the default Indian scale
  format). A shop setting, not a product one.
- **The Z report** is the cash-session close plus the day's totals by payment
  method, by tax rate and by user, with a documents-issued line (first and
  last number, cancelled count), which is GSTR-1 Table 13's row for the day.
- **Purchases stay in scope.** A shop that cannot record input tax cannot
  reconcile GSTR-3B, and the supplier's rate is *as charged*, never the shop's
  outward rate that `documents.ts:92` uses for purchase orders.

## File-level task list

- CSV catalogue import with dry run — `services/import.ts`: parse, validate
  each row to `{ok, code}`, return the plan (`create N, update M, skip K` with
  reasons), apply only on confirm inside one transaction. Columns: name,
  barcode, hsn, tax %, unit, rate, opening qty. `[delegate: Opus]` for the
  matcher (barcode, then exact name); the screen `[delegate: Sonnet/Haiku]`.
- Cash-close history — done in Phase 1d; add a date-range filter. `[delegate: Sonnet/Haiku]`
- Day book / Z report — `repos/dayBook.ts` plus a print layout, content as
  above. `[delegate: Opus]`
- Amend, retire, own password, categories — done in 1d.
- Purchases — `purchase_invoices` and `purchase_invoice_items` (supplier's
  HSN, rate, taxable, CGST/SGST/IGST as charged), a `U` series; receiving a PO
  creates the stock entry as today and links the invoice. `[delegate: Opus]`
- Supplier payables — allocations of `party_type = 'supplier'` payment
  entries against purchase invoices; a supplier statement mirroring
  `customerStatement`. `[delegate: Sonnet/Haiku]`, after purchases.
- Expenses — `expenses` table (date, head, amount, method, session_id,
  note); cash expenses move cash out of the open session. `[delegate: Sonnet/Haiku]`
- Customer ageing (0–30, 31–60, 61–90, 90+) over `loadOpenBills`. `[delegate: Sonnet/Haiku]`
- Per-item stock movement; dead stock (no sale in N days, stock > 0). `[delegate: Sonnet/Haiku]`
- Tier labels on the receipt and the customer card. `[delegate: Sonnet/Haiku]`
- Tamil on receipt and PDF — as decided; `pdf.rs` gains a shaper module and a
  font table; the receipt gains a raster path. `[delegate: Opus]`
- WhatsApp share — as decided. `[delegate: Sonnet/Haiku]`
- Open-price item — done in 0.2.6 (068, `products.open_price`): the counter
  asks for the amount, any cashier may give it, a bill refuses it at nothing.
- Quick keys, weight-embedded barcodes — a `barcode_layout` setting and a
  parser in `domain/barcodes.ts`. `[delegate: Sonnet/Haiku]`
- GSTR-1 working file — `repos/gstr1.ts`: B2B (by GSTIN, invoice-wise), B2CL
  (inter-state above ₹1 lakh, invoice-wise), B2CS (rate × place of supply
  totals), CDNR/CDNUR (credit notes with the original invoice), HSN summary
  (Table 12, B2B and B2C tabs, 4 or 6 digits by a turnover setting),
  documents issued (Table 13 from `doc_sequences` and cancelled counts). One
  workbook, one sheet each. `[delegate: Opus]` — the mapping is the
  bookkeeping; the sheet writer is mechanical.
- **Customer buckets** — `customer_groups`, nullable `customers.group_id`, a
  service, a screen; migration classified additive; rolled out on the bench
  to a shop whose second till is off. `[delegate: Sonnet/Haiku]` for the
  feature; the rollout drill `[delegate: Opus]`.

## Dependencies

- Phase 4 shipped, so each feature is an update, which is the point.
- Purchases before payables. GSTR-1 needs Phase 1's snapshot columns and
  returns-in-reports.

## Verification

- [ ] CSV dry run on a 2,000-row file reports counts matching a hand count of a 20-row sample; apply, re-run: `create 0`
- [ ] Z report for a day on the owner's copy ties to `salesSummary` and the session's `actual_cash`
- [ ] A purchase invoice with 18% IGST from another state shows as ITC in a GSTR-3B summary; stock and payables move
- [ ] A Tamil product name renders correctly shaped on the A4 PDF (compared with the browser's rendering) and legibly on a thermal test print
- [ ] "Send on WhatsApp" opens WhatsApp Desktop with the summary; the PDF is in the chosen folder
- [ ] GSTR-1 workbook on the owner's copy: B2B + B2CL + B2CS + CDNR taxable totals equal `taxByRate` for the range; Table 13 first and last numbers equal `doc_sequences`
- [ ] Customer buckets: a v(N) till with the feature and a v(N−1) till without it sync on the bench with no refusal; the older till ignores `group_id` and the newer one reports it
