-- What the paper said, kept on the bill that said it.
--
-- Rule 46 requires an invoice to carry the recipient's name, address, GSTIN and
-- the place of supply. This product has been reading all four off a live join
-- to `customers` at the moment somebody asked for a reprint or a GST export --
-- so a customer who moved premises, corrected their GSTIN or was renamed
-- silently changed every invoice ever issued to them. A reprint no longer
-- matched the copy in their hand, and the export no longer matched the
-- original return.
--
-- That is rule 4 of this schema applied to the one place it had been missed: a
-- submitted document is never rewritten. The document has to hold its own
-- evidence. These five columns are that evidence, written at submit and read by
-- every renderer and every report from here on.
--
-- ── supply_type, and why it is derived from where the tax landed ──────────
--
-- Intra-state or inter-state decides whether a line carries CGST+SGST or IGST,
-- and it was being recomputed from the customer's state every time anybody
-- looked. For bills already raised there is better evidence than the customer's
-- current address: the tax that was actually charged. A bill with IGST on any
-- line was treated as inter-state at the time it was billed, whatever the
-- customer record says today. That is what the shop charged and what the
-- customer paid, so it is what the invoice says.
--
-- ── customer_state_code is deliberately not backfilled ────────────────────
--
-- There is nothing honest to fill it from. Every `customers.state_code` in
-- existence is the literal `'33'` that `customers.ts:152` writes into the
-- INSERT -- a SQL literal, never a parameter, so no person has ever entered
-- one and no row means anything. Backfilling from it would turn a fabrication
-- into a fact stamped on an invoice.
--
-- Left null, the renderers can say the place of supply is unknown for old
-- bills, which is true. Phase 1a adds the field to the customer form and
-- derives it from the GSTIN prefix where there is one.
--
-- For the same reason the fabricated value is cleared rather than kept. `rev`
-- is deliberately not bumped: every till runs this migration and arrives at the
-- same state, so replicating the change would only manufacture a conflict
-- between two tills that already agree.
--
-- ── The return columns ────────────────────────────────────────────────────
--
-- A credit note has to carry the same HSN and rate as the line it reverses
-- (Rule 53), and `sales_return_items` has never held either -- so the GST
-- export cannot report a return at all without joining back through
-- `bill_items`, and Phase 1a needs them as columns to union over. Copied from
-- the bill line they came from, which is the only correct source: the rate on
-- the product today is not the rate that was charged.

ALTER TABLE bills ADD COLUMN supply_type TEXT
  CHECK (supply_type IN ('intra_state', 'inter_state'));
ALTER TABLE bills ADD COLUMN customer_gstin TEXT;
ALTER TABLE bills ADD COLUMN customer_address TEXT;
ALTER TABLE bills ADD COLUMN customer_state_code TEXT;
ALTER TABLE bills ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0
  CHECK (reverse_charge IN (0, 1));

-- Submitted and cancelled only. A draft has not said anything to anybody yet,
-- and it will take its snapshot when it is submitted.
UPDATE bills SET supply_type = CASE
  WHEN EXISTS (
    SELECT 1 FROM bill_items bi WHERE bi.bill_id = bills.id AND bi.igst_amount > 0
  ) THEN 'inter_state'
  ELSE 'intra_state'
END
WHERE docstatus IN (1, 2);

UPDATE bills SET
  customer_gstin   = (SELECT c.gstin   FROM customers c WHERE c.id = bills.customer_id),
  customer_address = (SELECT c.address FROM customers c WHERE c.id = bills.customer_id)
WHERE customer_id IS NOT NULL AND docstatus IN (1, 2);

UPDATE customers SET state_code = NULL WHERE state_code IS NOT NULL;

ALTER TABLE sales_return_items ADD COLUMN hsn_code TEXT;
ALTER TABLE sales_return_items ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0;

UPDATE sales_return_items SET
  hsn_code    = (SELECT bi.hsn_code    FROM bill_items bi WHERE bi.id = sales_return_items.bill_item_id),
  tax_rate_bp = COALESCE(
    (SELECT bi.tax_rate_bp FROM bill_items bi WHERE bi.id = sales_return_items.bill_item_id), 0);
