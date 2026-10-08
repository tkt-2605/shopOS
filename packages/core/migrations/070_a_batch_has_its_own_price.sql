-- A batch with its own MRP and selling price, and the cash a customer handed over.
--
-- The same item under the same barcode comes in again at a new MRP: the
-- manufacturer printed 12.00 on last month's packs and 14.00 on this month's,
-- and both are on the shelf together. The law will not let the shop charge
-- more than the MRP printed on the pack in the customer's hand, so the price is
-- a fact about the batch, not about the item. This is how every billing package
-- an Indian shop has used handles it (Marg, GoFrugal, Busy all keep MRP and
-- rate per batch): a scan of an item whose batches on the shelf differ in price
-- asks which one, and a scan whose batches all agree asks nothing.
--
-- `batches.mrp` and `batches.rate` are null for a batch that carries no price
-- of its own, which is every batch before this one: it sells at the item's.
-- `rate` is per base unit, tax inside, like `products.base_rate`.
--
-- `bill_items.batch_id` is the batch a line was priced from, so a held bill
-- brought back on another till still knows it and still sells out of it first.
-- Null is a line priced from the item, as every line was before this.
--
-- `bill_payments.tendered` is what the customer handed over for a cash tender,
-- so the receipt can say "Cash 500.00, change 140.00". Null is not asked,
-- which is every payment before this and any tender that was not cash.
--
-- Breaking, for the batch price: a till below this receives the batch without
-- it and bills the 14.00 pack at the item's 12.00 -- below the MRP on the pack,
-- which is a loss, or, the other way round, above it, which is an offence.

ALTER TABLE batches ADD COLUMN mrp INTEGER CHECK (mrp IS NULL OR mrp >= 0);
ALTER TABLE batches ADD COLUMN rate INTEGER CHECK (rate IS NULL OR rate >= 0);

ALTER TABLE bill_items ADD COLUMN batch_id TEXT REFERENCES batches(id);

ALTER TABLE bill_payments ADD COLUMN tendered INTEGER CHECK (tendered IS NULL OR tendered >= 0);
