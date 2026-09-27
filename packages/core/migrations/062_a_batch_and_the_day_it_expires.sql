-- Batch numbers and expiry dates.
--
-- A strip of tablets, a tin of formula and a packet of biscuits each carry a
-- batch number and a date after which they must not be sold. A shop that has
-- to answer "which batch did this customer get" or "what expires this month"
-- needs the stock split by batch, and nothing held that split.
--
-- The split lives beside the stock ledger rather than inside it. `stock_ledger`
-- stays the truth about how much there is and what it is worth; valuation does
-- not change, and a product never given a batch behaves exactly as it did.
-- Three tables, all new:
--
-- - `batches`: one row per batch of one product, with its expiry. The id is
--   derived from the product and the batch number, not minted, so two tills
--   that receive the same batch while apart write the same row and it merges
--   into one rather than clashing on a name.
-- - `batch_movements`: how much of a batch came in or went out, and on what.
--   Only ever inserted, like the ledger, and it travels on its own like the
--   ledger, so a merge of the document it belongs to cannot lose it. A batch's
--   balance is the sum of its movements, worked out when asked: there is no
--   cache, so there is nothing to drift.
-- - `stock_entry_batches`: which batch a line of a stock entry is for, between
--   the entry being written and being posted. A line of the entry, and it
--   travels inside it.
--
-- Additive: three new tables, their indexes and triggers. A till below this
-- skips the rows as a table it does not have, and goes on exchanging every
-- other row; the batches reach it when it is updated and the rows are next
-- sent. Nothing writes a row here until a shop switches the feature on.

CREATE TABLE batches (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id),
  batch_no     TEXT NOT NULL CHECK (length(batch_no) BETWEEN 1 AND 40),
  expiry_date  TEXT CHECK (expiry_date IS NULL
                 OR expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  rev          INTEGER NOT NULL DEFAULT 1,
  origin_id    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_batches_product ON batches(product_id);
CREATE INDEX idx_batches_expiry ON batches(expiry_date) WHERE expiry_date IS NOT NULL;

CREATE TABLE batch_movements (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES batches(id),
  product_id      TEXT NOT NULL REFERENCES products(id),
  qty_change      INTEGER NOT NULL CHECK (qty_change <> 0),
  voucher_type    TEXT NOT NULL,
  voucher_id      TEXT NOT NULL,
  voucher_line_id TEXT,
  posting_date    TEXT NOT NULL CHECK (posting_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_batch_movements_batch ON batch_movements(batch_id);
CREATE INDEX idx_batch_movements_product ON batch_movements(product_id);
CREATE INDEX idx_batch_movements_voucher ON batch_movements(voucher_type, voucher_id);
CREATE INDEX idx_batch_movements_line ON batch_movements(voucher_line_id) WHERE voucher_line_id IS NOT NULL;

CREATE TABLE stock_entry_batches (
  id        TEXT PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES stock_entries(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL,
  batch_id  TEXT NOT NULL REFERENCES batches(id)
) STRICT;

CREATE INDEX idx_stock_entry_batches_entry ON stock_entry_batches(entry_id);

-- A batch's revision, raised on every edit that is not a merge (039).
CREATE TRIGGER bump_rev_batches AFTER UPDATE ON batches FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE batches SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

-- Movements are the record of what happened. A wrong one is put right by a
-- reversing movement, as in the stock ledger (052).
CREATE TRIGGER batch_movements_is_append_only_upd BEFORE UPDATE ON batch_movements FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'batch_movements is append-only: post a reversing movement instead');
END;

CREATE TRIGGER batch_movements_is_append_only_del BEFORE DELETE ON batch_movements FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'batch_movements is append-only: post a reversing movement instead');
END;

CREATE TRIGGER feed_batches_ins AFTER INSERT ON batches FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'batches' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('batches', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_batches_upd AFTER UPDATE ON batches FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'batches' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('batches', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_batches_del AFTER DELETE ON batches FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'batches' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('batches', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_batch_movements_ins AFTER INSERT ON batch_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'batch_movements' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('batch_movements', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_batch_movements_upd AFTER UPDATE ON batch_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'batch_movements' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('batch_movements', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_batch_movements_del AFTER DELETE ON batch_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'batch_movements' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('batch_movements', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- A line of a stock entry: its change is a change to the entry (022).
CREATE TRIGGER feed_stock_entry_batches_ins AFTER INSERT ON stock_entry_batches FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_entries SET rev = rev + 1 WHERE id = NEW.entry_id;
END;

CREATE TRIGGER feed_stock_entry_batches_upd AFTER UPDATE ON stock_entry_batches FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_entries SET rev = rev + 1 WHERE id = NEW.entry_id;
END;

CREATE TRIGGER feed_stock_entry_batches_del AFTER DELETE ON stock_entry_batches FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = OLD.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', OLD.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_entries SET rev = rev + 1 WHERE id = OLD.entry_id;
END;
