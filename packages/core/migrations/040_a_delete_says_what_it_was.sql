-- A delete says which version of the row it deleted.
--
-- ── What was wrong ────────────────────────────────────────────────────────
--
-- `merge.ts` has always had the right rule for this and has never been able to
-- apply it. `decideDeletion` says a delete beats an edit that did not know
-- about it, with one exception — "a row the far side edited *after* the delete
-- travelled, which is not a disagreement at all, it is somebody deliberately
-- bringing something back" — and then, in the same comment, "the transport can
-- only tell those apart with the revision the deleting side last saw".
--
-- Nothing put one on the wire. `collectChanges` reads the row to build a record
-- and a deleted row is not there to read, so every delete crossed with
-- `row: null`, `deletedRev` came back null on the other side, and the `keep`
-- branch was unreachable code. A delete always won.
--
-- That is not merely a dropped edit. It does not settle, and on a ring of more
-- than two tills it never stops:
--
--   Till A deletes a product. Till B still has it, because B edited it and B's
--   copy is the one the shop wants. A's delete reaches B and wins, because it
--   always wins. C, who has not heard yet, offers B the row back. B has it
--   again. B tells A, who has it again. A's feed still says delete.
--
-- Four tills, one product, and a round of traffic every forty-five seconds for
-- ever. `converges.test.ts` finds it as a shop that never goes quiet, with one
-- row bouncing between two edges and a till that does not have it.
--
-- ── What this changes ─────────────────────────────────────────────────────
--
-- One nullable column on the feed, written by the delete triggers, carried in
-- the record, and read by the rule that was already written for it.
--
-- This is not the payload `021` refuses to store, and the distinction is worth
-- being exact about. `origin_device` from 036 is the same kind of thing: not a
-- copy of the row, but a fact about the change to it, which is what the feed
-- has always been for. A revision number cannot be used to reconstruct the row
-- and is of no use to anything except deciding whether somebody else's version
-- is newer — which is the one question a deleted row leaves behind and the one
-- question nothing was able to answer.
--
-- Only the 22 record triggers on tables that carry `rev` are recreated.
-- `stock_ledger` and `loyalty_entries` have none and are append-only, so a
-- delete of one is not a thing that happens; the twelve line triggers mark
-- their parent as an upsert and are not deletes at all.
--
-- ── What it does not fix ──────────────────────────────────────────────────
--
-- The feed entry is the tombstone, and it is pruned once every peer has
-- acknowledged it. A till switched off for longer than that comes back holding
-- a row everybody else has forgotten deleting, offers it, and it returns. That
-- is the known cost of keeping no permanent tombstone, and the answer to it is
-- a soft delete — `deleted_at` is a column on a row that stays, so there is
-- always something to compare and nothing to forget. The screens that delete
-- move to one; this is what makes the rest converge, including the deletes this
-- codebase does not control.
--
-- Additive. A peer on an older build sends `row: null` for a delete exactly as
-- it does today, which reads as "cannot tell" and falls back to the delete
-- winning — the behaviour it has now. Nothing refuses, nothing stalls.

ALTER TABLE change_feed ADD COLUMN deleted_rev INTEGER;

DROP TRIGGER feed_attachments_del;
CREATE TRIGGER feed_attachments_del AFTER DELETE ON attachments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'attachments' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('attachments', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_bills_del;
CREATE TRIGGER feed_bills_del AFTER DELETE ON bills FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('bills', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_cash_sessions_del;
CREATE TRIGGER feed_cash_sessions_del AFTER DELETE ON cash_sessions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('cash_sessions', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_categories_del;
CREATE TRIGGER feed_categories_del AFTER DELETE ON categories FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'categories' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('categories', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_customer_item_prices_del;
CREATE TRIGGER feed_customer_item_prices_del AFTER DELETE ON customer_item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customer_item_prices' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('customer_item_prices', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_customers_del;
CREATE TRIGGER feed_customers_del AFTER DELETE ON customers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customers' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('customers', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_documents_del;
CREATE TRIGGER feed_documents_del AFTER DELETE ON documents FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('documents', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_doc_formats_del;
CREATE TRIGGER feed_doc_formats_del AFTER DELETE ON doc_formats FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'doc_formats' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('doc_formats', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_item_prices_del;
CREATE TRIGGER feed_item_prices_del AFTER DELETE ON item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'item_prices' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('item_prices', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_payment_entries_del;
CREATE TRIGGER feed_payment_entries_del AFTER DELETE ON payment_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('payment_entries', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_price_lists_del;
CREATE TRIGGER feed_price_lists_del AFTER DELETE ON price_lists FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'price_lists' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('price_lists', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_product_barcodes_del;
CREATE TRIGGER feed_product_barcodes_del AFTER DELETE ON product_barcodes FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_barcodes' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('product_barcodes', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_product_units_del;
CREATE TRIGGER feed_product_units_del AFTER DELETE ON product_units FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_units' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('product_units', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_products_del;
CREATE TRIGGER feed_products_del AFTER DELETE ON products FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'products' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('products', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_registers_del;
CREATE TRIGGER feed_registers_del AFTER DELETE ON registers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'registers' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('registers', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_roles_del;
CREATE TRIGGER feed_roles_del AFTER DELETE ON roles FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('roles', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_sales_returns_del;
CREATE TRIGGER feed_sales_returns_del AFTER DELETE ON sales_returns FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('sales_returns', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_settings_del;
CREATE TRIGGER feed_settings_del AFTER DELETE ON settings FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'settings' AND row_id = OLD.key;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('settings', OLD.key, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_stock_counts_del;
CREATE TRIGGER feed_stock_counts_del AFTER DELETE ON stock_counts FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('stock_counts', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_stock_entries_del;
CREATE TRIGGER feed_stock_entries_del AFTER DELETE ON stock_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('stock_entries', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_suppliers_del;
CREATE TRIGGER feed_suppliers_del AFTER DELETE ON suppliers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'suppliers' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('suppliers', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_users_del;
CREATE TRIGGER feed_users_del AFTER DELETE ON users FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'users' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('users', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;
