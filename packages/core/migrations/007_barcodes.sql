-- More than one barcode on the same item.
--
-- The same notebook carries the manufacturer's EAN and the shop's own printed
-- label. A loose item bought in bulk and repacked has whatever the shop stuck on
-- it. Scanning either has to find the same product, and until now a product had
-- exactly one barcode, so the second label found nothing and the cashier typed
-- the name instead.

CREATE TABLE product_barcodes (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  barcode    TEXT NOT NULL,
  -- What this one is: "manufacturer", "our label", "old packet". Free text,
  -- because a shop's reasons are its own.
  label      TEXT,
  -- The one that represents the item — printed on a shelf tag, shown in lists.
  -- Kept in step with products.barcode by setBarcodes(), which owns the pair.
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  rev        INTEGER NOT NULL DEFAULT 1,
  origin_id  TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- A barcode points at one product or the scanner is a guess. Created before the
-- backfill on purpose: nothing stopped two products sharing a barcode until now,
-- and the INSERT below skips the loser rather than failing the migration on a
-- shop that has one.
CREATE UNIQUE INDEX idx_product_barcodes_code ON product_barcodes (barcode);
CREATE INDEX idx_product_barcodes_product ON product_barcodes (product_id);

-- Every barcode a shop already has, as the primary one for its product. The id
-- is random hex rather than the UUIDv7 the application mints, because SQL cannot
-- generate one; these rows are never sorted by id and nothing outside this table
-- refers to them.
INSERT OR IGNORE INTO product_barcodes (id, product_id, barcode, label, is_primary, created_at)
SELECT lower(hex(randomblob(16))), id, TRIM(barcode), NULL, 1, created_at
  FROM products
 WHERE barcode IS NOT NULL AND TRIM(barcode) <> '' AND deleted_at IS NULL;
