-- Whether an item's versions follow its price.
--
-- An XO pen in six colours is six products under one parent (`parent_product_id`),
-- each with its own stock. Most shops sell every
-- colour at one price, and keeping six prices in step by hand is how one of
-- them ends up a rupee behind. `products.family_price` is set on the parent:
-- 1 means its versions take its selling price, MRP, tax and cost each time it
-- is saved (`services/variants.ts`); null is each version priced on its own,
-- as every version was before this.
--
-- No backfill: every existing family reads as priced one by one, which is how
-- each of them has been kept.
--
-- Additive: a nullable column on products, read only when an item is saved and
-- never by billing, pricing, tax or valuation, which go on reading each
-- version's own row. A parent saved on a till below 085 arrives without it and
-- reads as null; the worst that does is a family that stops following its
-- price until the owner ticks the box again, with every price as it was.

ALTER TABLE products ADD COLUMN family_price INTEGER CHECK (family_price IS NULL OR family_price IN (0, 1));
