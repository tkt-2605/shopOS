-- A draft return stays on the till it is being made on, as a draft bill does.
--
-- 042 kept draft bills off the wire. Draft returns were left travelling, and
-- `createAndSubmitReturn` makes one in one transaction and submits or deletes
-- it in another -- so every return went out twice, and one abandoned on the
-- way was a hard delete of a row the other tills had already been sent. 041
-- sets out why a delete does not settle round a ring of three or more tills.
-- A draft that never travelled has nothing to settle.
--
-- The same shape as 042: the row triggers and the line triggers stand down
-- while the return is a draft, and `replicaShape.ts` says `docstatus <> 0`
-- for the full resend. Drafts already in the feed are taken out of it.
--
-- Additive: triggers only. A till below this still sends drafts, and one
-- arriving here is a return nobody here can see until it is submitted.

DROP TRIGGER feed_sales_returns_ins;
CREATE TRIGGER feed_sales_returns_ins AFTER INSERT ON sales_returns FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND NEW.docstatus <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

DROP TRIGGER feed_sales_returns_upd;
CREATE TRIGGER feed_sales_returns_upd AFTER UPDATE ON sales_returns FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND NEW.docstatus <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

DROP TRIGGER feed_sales_returns_del;
CREATE TRIGGER feed_sales_returns_del AFTER DELETE ON sales_returns FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND OLD.docstatus <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('sales_returns', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_sales_return_items_ins;
CREATE TRIGGER feed_sales_return_items_ins AFTER INSERT ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM sales_returns WHERE id = NEW.return_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE sales_returns SET rev = rev + 1 WHERE id = NEW.return_id;
END;

DROP TRIGGER feed_sales_return_items_upd;
CREATE TRIGGER feed_sales_return_items_upd AFTER UPDATE ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM sales_returns WHERE id = NEW.return_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE sales_returns SET rev = rev + 1 WHERE id = NEW.return_id;
END;

DROP TRIGGER feed_sales_return_items_del;
CREATE TRIGGER feed_sales_return_items_del AFTER DELETE ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM sales_returns WHERE id = OLD.return_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = OLD.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', OLD.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE sales_returns SET rev = rev + 1 WHERE id = OLD.return_id;
END;

DELETE FROM change_feed
 WHERE table_name = 'sales_returns'
   AND row_id IN (SELECT id FROM sales_returns WHERE docstatus = 0);
