-- Feature switches, and what a return actually did.
--
-- Two capabilities become optional: several barcodes on one item, and quantity
-- price breaks. Both are built, both are clutter in a shop that does not want
-- them, and neither may be lost by being switched off — so this decides the
-- starting position from the data rather than imposing one.
--
-- A shop already using a thing keeps it. A shop that is not, and every new shop,
-- starts simple and can turn it on.

INSERT INTO settings (key, value, updated_at)
SELECT 'feature_multi_barcode',
       CASE WHEN EXISTS (
         SELECT 1 FROM product_barcodes GROUP BY product_id HAVING COUNT(*) > 1
       ) THEN 'on' ELSE 'off' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'feature_multi_barcode');

-- A ladder is two rungs against the same item, list and unit. One rung is just
-- a price, which every shop has whether or not it wants quantity breaks.
INSERT INTO settings (key, value, updated_at)
SELECT 'feature_tiered_pricing',
       CASE WHEN EXISTS (
         SELECT 1 FROM item_prices WHERE deleted_at IS NULL
          GROUP BY product_id, price_list_id, sale_unit HAVING COUNT(*) > 1
       ) OR EXISTS (
         SELECT 1 FROM customer_item_prices WHERE deleted_at IS NULL
          GROUP BY customer_id, product_id, sale_unit HAVING COUNT(*) > 1
       ) THEN 'on' ELSE 'off' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'feature_tiered_pricing');

-- A return refunds goods, but a bill is not always paid in one currency. A
-- customer who settled ₹1,000 with ₹900 and 100 points' worth of points is owed
-- ₹900 and 100 points' worth of points back when the whole lot comes back.
--
-- refund_total stays the value of the goods — that is what the credit note
-- reverses for GST, however it was paid. These record what was actually handed
-- over, so a return can be explained and undone exactly.
ALTER TABLE sales_returns ADD COLUMN refund_cash     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales_returns ADD COLUMN points_restored INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales_returns ADD COLUMN points_removed  INTEGER NOT NULL DEFAULT 0;

-- The receipt raised when a refund goes back onto the khata rather than into a
-- hand. Without it the goods came back and the customer still owed for them.
ALTER TABLE sales_returns ADD COLUMN credit_note_id TEXT REFERENCES payment_entries(id);

-- Returns taken before this migration paid out their whole value in money,
-- because that is all the code could do.
UPDATE sales_returns SET refund_cash = refund_total WHERE docstatus = 1;

-- How much of a redemption has been handed back. `reversed_at` says a whole
-- redemption was undone, which is what cancelling the bill does; a return gives
-- back part of one, and part has nowhere to be written down without this.
ALTER TABLE loyalty_redemptions ADD COLUMN restored INTEGER NOT NULL DEFAULT 0;
