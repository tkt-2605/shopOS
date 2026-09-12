-- Items that must not be discounted, and items that must not earn points.
--
-- `discount_blocked` has been in the schema since v1 and nothing has ever read
-- it. This migration adds its counterpart and the two are honoured together
-- from here on.
--
-- The reason is margin, not policy. A shop sells recharge vouchers, cigarettes,
-- milk and cooking gas at a few rupees a unit; a 5% festival rule across the
-- whole bill, or a loyalty programme paying back 1%, turns those lines into a
-- loss. The exclusion belongs on the item because that is where the margin is,
-- and it has to hold against every later rule rather than be remembered by
-- whoever writes the rule.

ALTER TABLE products ADD COLUMN loyalty_blocked INTEGER NOT NULL DEFAULT 0;

-- Recorded on the line as it was at the time of sale, so a bill can still be
-- explained after the flag on the product is changed. Backfilled to 0, which is
-- what every existing bill was rung up under.
ALTER TABLE bill_items ADD COLUMN discount_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bill_items ADD COLUMN loyalty_blocked  INTEGER NOT NULL DEFAULT 0;

-- The margin figure the exclusion exists to protect, so the owner can find the
-- items that ought to carry it. Null means "not set", which is not the same as
-- zero and must not read as a thin margin.
ALTER TABLE products ADD COLUMN min_margin_bp INTEGER;
