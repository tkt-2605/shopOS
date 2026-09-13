-- Counting what is actually on the shelf.
--
-- Every shop's system stock drifts. A packet breaks, a customer walks out with
-- something, an entry is typed as 10 instead of 100, a boy takes a bottle for
-- his tea. Within a month the figures are fiction, and a shopkeeper who has once
-- seen the software say 14 when there are 9 stops believing any of it — which is
-- worse than having no stock figures at all, because the reports built on them
-- look authoritative.
--
-- The sheet is its own document. What it produces is an ordinary adjustment
-- stock entry holding only the differences, so there stays exactly one path into
-- the ledger and the valuation, and a count can be cancelled the way any other
-- entry is.

CREATE TABLE stock_counts (
  id            TEXT PRIMARY KEY,
  doc_no        TEXT NOT NULL UNIQUE,
  docstatus     INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0, 1, 2)),
  -- What was counted, kept so a half-finished sheet can say what it covers.
  scope         TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'category', 'chosen')),
  category_id   TEXT REFERENCES categories(id),
  note          TEXT,
  -- When the sheet was opened, which is the moment the expected quantities below
  -- were true. The gap between this and the submit is where the shop keeps
  -- selling, and is why the difference is posted rather than the count.
  opened_at     TEXT NOT NULL,
  posting_date  TEXT NOT NULL,
  -- The adjustment this count produced, if any of the lines differed.
  entry_id      TEXT REFERENCES stock_entries(id),
  created_by    TEXT NOT NULL REFERENCES users(id),
  rev           INTEGER NOT NULL DEFAULT 1,
  origin_id     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
) STRICT;

CREATE TABLE stock_count_items (
  id            TEXT PRIMARY KEY,
  count_id      TEXT NOT NULL REFERENCES stock_counts(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  -- What the system believed when the sheet opened. Frozen: the whole document
  -- is a comparison against a moment, and a moving figure compares to nothing.
  expected_qty  INTEGER NOT NULL,
  -- Null until someone has actually counted that line. Zero is a real answer and
  -- an important one — it is how a shop finds what it has run out of — so the
  -- two cannot share a value.
  counted_qty   INTEGER,
  -- What one unit was worth when the sheet opened, so goods found are brought
  -- back in at the price they left at rather than at zero, which would dilute
  -- the moving average every time someone counted.
  unit_cost     INTEGER,
  UNIQUE (count_id, product_id)
) STRICT;

CREATE INDEX idx_stock_count_items_count ON stock_count_items (count_id);
CREATE INDEX idx_stock_counts_open ON stock_counts (docstatus) WHERE deleted_at IS NULL;
