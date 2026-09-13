-- A quantity ladder for one customer and one item.
--
-- A customer-specific rate has been a single number since v1: Ramesh Stores buys
-- this pen at ₹8, however many he takes. But the whole reason a shop negotiates
-- with a regular is quantity — "₹9 normally, ₹8 if you take ten, ₹7 for fifty" —
-- and that is exactly what the price lists could already express and the
-- customer's own rate could not.
--
-- The unique key has to change to allow more than one row per customer, item and
-- unit, and SQLite cannot alter a table constraint. So the table is rebuilt: the
-- standard create-copy-drop-rename, which is safe inside the transaction each
-- migration already runs in, and safe against foreign keys because no other
-- table points at this one.
--
-- Every existing row becomes a rung at quantity zero — "always applies" — which
-- is precisely what those rows have meant until now.

CREATE TABLE customer_item_prices_new (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  sale_unit   TEXT NOT NULL,
  min_qty     INTEGER NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  rate        INTEGER NOT NULL CHECK (rate >= 0),
  valid_from  TEXT,
  valid_to    TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  origin_id   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  UNIQUE (customer_id, product_id, sale_unit, min_qty)
) STRICT;

INSERT INTO customer_item_prices_new
  (id, customer_id, product_id, sale_unit, min_qty, rate, valid_from, valid_to,
   rev, origin_id, created_at, updated_at, deleted_at)
SELECT id, customer_id, product_id, sale_unit, 0, rate, valid_from, valid_to,
       rev, origin_id, created_at, updated_at, deleted_at
  FROM customer_item_prices;

DROP TABLE customer_item_prices;

ALTER TABLE customer_item_prices_new RENAME TO customer_item_prices;

-- The lookup the counter does on every line, and it drops with the old table.
CREATE INDEX idx_customer_item_prices_lookup
  ON customer_item_prices (customer_id, product_id, sale_unit);
