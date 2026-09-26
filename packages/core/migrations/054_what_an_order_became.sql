-- What a quotation or a purchase order became, one row per line converted.
--
-- `document_items.fulfilled_qty` is raised in place when a quotation becomes
-- an order and when a purchase order is received, and nothing else recorded
-- that it happened. A bill against an order leaves a `bill_fulfilments` row;
-- these two left none. So the figure could not be checked or rebuilt, and two
-- tills converting against one document while apart each raised their own
-- copy, one copy won the merge, and the other's step was simply gone.
--
-- Each conversion now writes a row here in the same transaction that creates
-- what it became. Rows are only ever inserted, travel on their own like the
-- stock ledger, and are never lost to a merge -- so `reconcileFulfilledQty`
-- can put `fulfilled_qty` back to what the bills and these rows say it is.
--
-- ## Conversions made before this
--
-- Backfilled as one row per line for whatever `fulfilled_qty` holds beyond
-- the bills' share, with `target_kind` saying where it came from. The id is
-- derived from the line, not minted, so two tills running this migration
-- write the same row and it merges into one rather than counting twice.
--
-- Additive: a new table, its indexes and triggers.

CREATE TABLE document_fulfilments (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES documents(id),
  document_item_id TEXT NOT NULL REFERENCES document_items(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  target_kind      TEXT NOT NULL CHECK (target_kind IN ('document', 'stock_entry', 'before_054')),
  target_id        TEXT,
  created_at       TEXT NOT NULL
) STRICT;

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

INSERT INTO document_fulfilments (id, document_id, document_item_id, qty, target_kind, target_id, created_at)
SELECT 'before-054-' || di.id, di.document_id, di.id,
       di.fulfilled_qty - COALESCE((SELECT SUM(bf.qty) FROM bill_fulfilments bf WHERE bf.document_item_id = di.id), 0),
       'before_054', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM document_items di
 WHERE di.fulfilled_qty - COALESCE((SELECT SUM(bf.qty) FROM bill_fulfilments bf WHERE bf.document_item_id = di.id), 0) > 0;
