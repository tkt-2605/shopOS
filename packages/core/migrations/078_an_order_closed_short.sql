-- A purchase order the supplier will never finish.
--
-- A delivery short of the order used to have two ways to go and both were
-- wrong: receive the whole order and put goods on the shelf that never came,
-- or leave the order open for ever with a remainder nobody is waiting for.
-- Receiving now takes what actually arrived, line by line, and what the
-- supplier is not going to send can be closed short.
--
-- Closing is one more thing a line can become, so it is one more kind of
-- `document_fulfilments` row: the shortfall marked off with no stock entry
-- behind it. `fulfilled_qty` and `reconcileFulfilledQty` then need nothing
-- new -- the sum of the rows is still what the line is done with -- and the
-- row says, for good, that this part was given up rather than received.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt, as 015 did.
-- STRICT, the column order, the indexes and the triggers are carried over
-- unchanged. Dropping the table fires none of its triggers, so the rebuild
-- puts nothing in `change_feed`.
--
-- Breaking: a till below this refuses a `closed` row at the CHECK, and would
-- show a closed order as still open.

CREATE TABLE document_fulfilments_new (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES documents(id),
  document_item_id TEXT NOT NULL REFERENCES document_items(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  target_kind      TEXT NOT NULL CHECK (target_kind IN ('document', 'stock_entry', 'before_054', 'closed')),
  target_id        TEXT,
  created_at       TEXT NOT NULL
) STRICT;

INSERT INTO document_fulfilments_new (id, document_id, document_item_id, qty, target_kind, target_id, created_at)
SELECT id, document_id, document_item_id, qty, target_kind, target_id, created_at FROM document_fulfilments;

DROP TABLE document_fulfilments;
ALTER TABLE document_fulfilments_new RENAME TO document_fulfilments;

CREATE INDEX idx_document_fulfilments_item ON document_fulfilments(document_item_id);
CREATE INDEX idx_document_fulfilments_document ON document_fulfilments(document_id);

CREATE TRIGGER feed_document_fulfilments_ins AFTER INSERT ON document_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'document_fulfilments' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('document_fulfilments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_document_fulfilments_upd AFTER UPDATE ON document_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'document_fulfilments' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('document_fulfilments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_document_fulfilments_del AFTER DELETE ON document_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'document_fulfilments' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('document_fulfilments', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
