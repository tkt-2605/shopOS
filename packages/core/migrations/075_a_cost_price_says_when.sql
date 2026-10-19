-- When an item's cost price was last set.
--
-- `products.cost_price_at` is the instant somebody typed or changed the cost
-- price (074), and null when there is none. It settles one question: whether
-- the cost price or the last price actually paid is the one to suggest. The
-- more recent wins -- a cost price typed after the last delivery is what the
-- owner now means, and a delivery after it is newer news (`repos/costs.ts`).
--
-- On the item, not read from the audit trail, because the audit trail stays on
-- the till that wrote it: two tills would suggest two different costs for one
-- item. This travels with the row, so every till answers the same.
--
-- Backfill: an item that already has a cost price takes its last edit as the
-- time it was set. 074 is a day old and no shop has run it but the vendor's own
-- test tills, so the guess is close to true wherever it is made.
--
-- Additive: a nullable column on products, read by nothing that bills, prices,
-- taxes or values. A row that last came through a till below 075 arrives
-- without it and reads as a cost price of unknown age, which loses to any
-- price actually paid -- the rule 074 shipped with.

ALTER TABLE products ADD COLUMN cost_price_at TEXT;

-- Every till runs this on its own rows, so it is not an edit to pass on: with
-- `applying` set the triggers neither bump the row nor put it on the feed.
UPDATE sync_state SET applying = 1 WHERE id = 1;
UPDATE products SET cost_price_at = updated_at WHERE cost_price IS NOT NULL;
UPDATE sync_state SET applying = 0 WHERE id = 1;
