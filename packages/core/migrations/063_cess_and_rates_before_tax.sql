-- GST compensation cess, and rates that are quoted before tax.
--
-- Two gaps the review of 4 October found in the tax arithmetic.
--
-- **Cess.** Tobacco, pan masala, aerated drinks and a handful of other goods
-- carry a compensation cess on top of GST, charged on the same taxable value
-- and reported in its own column of GSTR-1. Nothing here could hold one, so a
-- shop selling them either left it off the bill or folded it into the GST
-- rate -- and the second files the wrong rate. `products.cess_rate_bp` is the
-- ad valorem rate, in basis points like the GST rate beside it; each line
-- copies the rate it was charged at and the amount it came to, the way it
-- copies the GST rate. A cess charged per unit (cigarettes by the thousand
-- sticks) is not held here: it is rare in a shop this size and is a different
-- calculation, not a different number.
--
-- **Rates before tax.** Every rate in this product was a shelf price that
-- already included tax -- right for retail, where a packaged good is sold at
-- an MRP inclusive of all taxes. A wholesaler quotes the other way: the rate is
-- before tax and GST goes on top. That is a property of a price list, so
-- `price_lists.rates_include_tax` says which kind each list is. It is copied
-- onto each line rather than onto the bill, because a cart can hold lines
-- priced from two lists (a customer chosen after the first items were rung up)
-- and each rate has to be read the way it was quoted.
--
-- `line_total` keeps its meaning on every line of either kind: what the
-- customer pays for it, tax included. Returns, loyalty, the khata and every
-- report read that, and none of them has to learn the difference.
--
-- Breaking, not additive. Each default below is true of every row written
-- before this, but not of every row written after it: a product with a cess,
-- or a list quoted before tax, relayed through a till that has not got these
-- columns would arrive here as no cess and tax-inclusive, and the next bill
-- would be taxed wrong on a till that was never out of date. Nothing is
-- released yet, so the floor this raises cuts off no shop.

ALTER TABLE products ADD COLUMN cess_rate_bp INTEGER NOT NULL DEFAULT 0
  CHECK (cess_rate_bp >= 0);

ALTER TABLE price_lists ADD COLUMN rates_include_tax INTEGER NOT NULL DEFAULT 1
  CHECK (rates_include_tax IN (0, 1));

ALTER TABLE bill_items ADD COLUMN cess_rate_bp INTEGER NOT NULL DEFAULT 0
  CHECK (cess_rate_bp >= 0);
ALTER TABLE bill_items ADD COLUMN cess_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bill_items ADD COLUMN rate_includes_tax INTEGER NOT NULL DEFAULT 1
  CHECK (rate_includes_tax IN (0, 1));

ALTER TABLE document_items ADD COLUMN cess_rate_bp INTEGER NOT NULL DEFAULT 0
  CHECK (cess_rate_bp >= 0);
ALTER TABLE document_items ADD COLUMN cess_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_items ADD COLUMN rate_includes_tax INTEGER NOT NULL DEFAULT 1
  CHECK (rate_includes_tax IN (0, 1));

ALTER TABLE sales_return_items ADD COLUMN cess_amount INTEGER NOT NULL DEFAULT 0;
