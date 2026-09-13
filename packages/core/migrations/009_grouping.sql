-- Grouping items: by what they are, and by what they are a version of.
--
-- Two different needs that keep being confused for one.
--
-- A CATEGORY is what an item is — stationery, groceries, cold drinks. The table
-- has existed since v1 with nothing reading or writing it, which is why search
-- has only ever been a flat list of every product in the shop. It is what a
-- browsing screen and a future app need to show anything but an alphabet.
--
-- A VARIANT is what an item is a version of. The same pen in six colours is six
-- products today, with six barcodes and six stock counts, and that is correct —
-- they are six things on the shelf. What is missing is the thread between them,
-- so a search for "Cello gel pen" offers the six rather than burying them among
-- everything else beginning with C, and so a report can ask how the pen is
-- selling rather than how the blue one is.
--
-- Deliberately NOT ERPNext's template/attribute/variant-generator machinery: a
-- template item that cannot be sold, an attribute table, a generator that mints
-- products from combinations. That is a week of work and a class of bugs, for
-- something two columns answer.

ALTER TABLE products ADD COLUMN parent_product_id TEXT REFERENCES products(id);

-- What makes this one different: "blue", "500g", "large". Free text, because a
-- shop's distinctions are its own and an attribute system would only make them
-- someone else's.
ALTER TABLE products ADD COLUMN variant_label TEXT;

CREATE INDEX idx_products_parent ON products (parent_product_id)
  WHERE parent_product_id IS NOT NULL AND deleted_at IS NULL;
