-- When to buy more, and how much.
--
-- "What do I buy from the distributor on Tuesday" is one of the two questions a
-- shop asks the software every week. Answering it needs a line under which an
-- item counts as running out, and that line is per item: a shop can afford to
-- run out of birthday candles and cannot afford to run out of milk.
--
-- Null means the owner has not set one, which is not the same as zero and must
-- not read as "reorder when it hits nothing". Only items with a level set appear
-- on the buying list, so the list stays something a shop chose rather than a
-- wall of every product it has ever sold.

ALTER TABLE products ADD COLUMN reorder_level INTEGER;

-- How much to buy when it does run low. Usually a case size — a distributor
-- sells thermal rolls in tens whatever the shop would have preferred. Null falls
-- back to the reorder level itself, which is a suggestion a shopkeeper can
-- predict without doing arithmetic in their head.
ALTER TABLE products ADD COLUMN reorder_qty INTEGER;

-- The buying list reads these two for every active product, and a shop with
-- three thousand items reads it every week.
CREATE INDEX idx_products_reorder ON products (reorder_level)
  WHERE reorder_level IS NOT NULL AND deleted_at IS NULL;
