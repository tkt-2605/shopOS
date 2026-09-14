-- A document's revision moves when any part of it moves.
--
-- 021 made a line table mark its parent in the changefeed, so a bill whose lines
-- changed is *sent* whole. This is the other half: a bill whose lines changed
-- has *changed*, and until now its `rev` did not say so.
--
-- The gap is easiest to see on the permission grid. `saveRoleMatrix` writes
-- role_permissions and role_pages and then updates the role itself, so the
-- role's rev moves and everything is fine. `applyUpgrades` writes exactly the
-- same two tables and does not touch the role, because it has no reason to --
-- it is granting a newly added screen to the roles whose template names it.
-- After that the second till holds a role with the same rev and a different
-- permission set, and a merge comparing rev would keep its own and discard the
-- grant, while appearing to work.
--
-- That is 019's argument again, for the third time and in the same shape: an
-- invariant that call sites have to remember is not an invariant. `writeMatrix`
-- remembering and `grantPages` forgetting is not a bug in either of them, it is
-- a bug in expecting them to know. So the trigger does it, and a service written
-- next year cannot get it wrong.
--
-- Bumping more than once for one save is deliberate and harmless: `rev` is an
-- ordering, not a count of edits. 019 already settled that -- an UPDATE that
-- writes a column its existing value still bumps. What matters is only that a
-- local change always leaves it higher than the copy another till holds.
--
-- `sync_state.applying` now switches off two things rather than one, and that is
-- correct in both. A merge writing another till's bill must not feed it back,
-- and must not raise its revision either: the revision it is given is the one
-- the change arrived with, and bumping it here would make this copy look newer
-- than the machine the change came from -- so the next sync would send it
-- straight back as an edit nobody made.
--
-- ── doc_formats, which was owed ────────────────────────────────────────────
--
-- 021 fed doc_formats because the shop's own bill layouts have to reach the
-- second till -- two tills printing different bills is the whole problem -- and
-- recorded that it had nothing to settle a tie with. This gives it the same
-- `rev` and `origin_id` every other authored table carries, so the merge rule in
-- `domain/merge.ts` has something better to go on than the two machines' clocks.
--
-- Clocks are the reason `rev` exists at all. Two tills in one shop can disagree
-- by minutes, and on a wrong-by-an-hour clock the older edit wins every time and
-- nothing anywhere says so.

ALTER TABLE doc_formats ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE doc_formats ADD COLUMN origin_id TEXT;

CREATE TRIGGER bump_rev_doc_formats AFTER UPDATE ON doc_formats FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE doc_formats SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;


-- ── every line table, recreated to move its parent's revision too ─────

DROP TRIGGER feed_bill_items_ins;

CREATE TRIGGER feed_bill_items_ins AFTER INSERT ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_items_upd;

CREATE TRIGGER feed_bill_items_upd AFTER UPDATE ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_items_del;

CREATE TRIGGER feed_bill_items_del AFTER DELETE ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;

DROP TRIGGER feed_bill_payments_ins;

CREATE TRIGGER feed_bill_payments_ins AFTER INSERT ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_payments_upd;

CREATE TRIGGER feed_bill_payments_upd AFTER UPDATE ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_payments_del;

CREATE TRIGGER feed_bill_payments_del AFTER DELETE ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;

DROP TRIGGER feed_bill_fulfilments_ins;

CREATE TRIGGER feed_bill_fulfilments_ins AFTER INSERT ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_fulfilments_upd;

CREATE TRIGGER feed_bill_fulfilments_upd AFTER UPDATE ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_fulfilments_del;

CREATE TRIGGER feed_bill_fulfilments_del AFTER DELETE ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;

DROP TRIGGER feed_loyalty_redemptions_ins;

CREATE TRIGGER feed_loyalty_redemptions_ins AFTER INSERT ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_loyalty_redemptions_upd;

CREATE TRIGGER feed_loyalty_redemptions_upd AFTER UPDATE ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_loyalty_redemptions_del;

CREATE TRIGGER feed_loyalty_redemptions_del AFTER DELETE ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;

DROP TRIGGER feed_payment_allocations_ins;

CREATE TRIGGER feed_payment_allocations_ins AFTER INSERT ON payment_allocations FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = NEW.payment_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', NEW.payment_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE payment_entries SET rev = rev + 1 WHERE id = NEW.payment_id;
END;

DROP TRIGGER feed_payment_allocations_upd;

CREATE TRIGGER feed_payment_allocations_upd AFTER UPDATE ON payment_allocations FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = NEW.payment_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', NEW.payment_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE payment_entries SET rev = rev + 1 WHERE id = NEW.payment_id;
END;

DROP TRIGGER feed_payment_allocations_del;

CREATE TRIGGER feed_payment_allocations_del AFTER DELETE ON payment_allocations FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = OLD.payment_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', OLD.payment_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE payment_entries SET rev = rev + 1 WHERE id = OLD.payment_id;
END;

DROP TRIGGER feed_document_items_ins;

CREATE TRIGGER feed_document_items_ins AFTER INSERT ON document_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = NEW.document_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', NEW.document_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE documents SET rev = rev + 1 WHERE id = NEW.document_id;
END;

DROP TRIGGER feed_document_items_upd;

CREATE TRIGGER feed_document_items_upd AFTER UPDATE ON document_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = NEW.document_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', NEW.document_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE documents SET rev = rev + 1 WHERE id = NEW.document_id;
END;

DROP TRIGGER feed_document_items_del;

CREATE TRIGGER feed_document_items_del AFTER DELETE ON document_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = OLD.document_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', OLD.document_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE documents SET rev = rev + 1 WHERE id = OLD.document_id;
END;

DROP TRIGGER feed_cash_movements_ins;

CREATE TRIGGER feed_cash_movements_ins AFTER INSERT ON cash_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = NEW.session_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', NEW.session_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE cash_sessions SET rev = rev + 1 WHERE id = NEW.session_id;
END;

DROP TRIGGER feed_cash_movements_upd;

CREATE TRIGGER feed_cash_movements_upd AFTER UPDATE ON cash_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = NEW.session_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', NEW.session_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE cash_sessions SET rev = rev + 1 WHERE id = NEW.session_id;
END;

DROP TRIGGER feed_cash_movements_del;

CREATE TRIGGER feed_cash_movements_del AFTER DELETE ON cash_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = OLD.session_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', OLD.session_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE cash_sessions SET rev = rev + 1 WHERE id = OLD.session_id;
END;

DROP TRIGGER feed_role_pages_ins;

CREATE TRIGGER feed_role_pages_ins AFTER INSERT ON role_pages FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE roles SET rev = rev + 1 WHERE id = NEW.role_id;
END;

DROP TRIGGER feed_role_pages_upd;

CREATE TRIGGER feed_role_pages_upd AFTER UPDATE ON role_pages FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE roles SET rev = rev + 1 WHERE id = NEW.role_id;
END;

DROP TRIGGER feed_role_pages_del;

CREATE TRIGGER feed_role_pages_del AFTER DELETE ON role_pages FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = OLD.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', OLD.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE roles SET rev = rev + 1 WHERE id = OLD.role_id;
END;

DROP TRIGGER feed_role_permissions_ins;

CREATE TRIGGER feed_role_permissions_ins AFTER INSERT ON role_permissions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE roles SET rev = rev + 1 WHERE id = NEW.role_id;
END;

DROP TRIGGER feed_role_permissions_upd;

CREATE TRIGGER feed_role_permissions_upd AFTER UPDATE ON role_permissions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE roles SET rev = rev + 1 WHERE id = NEW.role_id;
END;

DROP TRIGGER feed_role_permissions_del;

CREATE TRIGGER feed_role_permissions_del AFTER DELETE ON role_permissions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = OLD.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', OLD.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE roles SET rev = rev + 1 WHERE id = OLD.role_id;
END;

DROP TRIGGER feed_sales_return_items_ins;

CREATE TRIGGER feed_sales_return_items_ins AFTER INSERT ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE sales_returns SET rev = rev + 1 WHERE id = NEW.return_id;
END;

DROP TRIGGER feed_sales_return_items_upd;

CREATE TRIGGER feed_sales_return_items_upd AFTER UPDATE ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE sales_returns SET rev = rev + 1 WHERE id = NEW.return_id;
END;

DROP TRIGGER feed_sales_return_items_del;

CREATE TRIGGER feed_sales_return_items_del AFTER DELETE ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = OLD.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', OLD.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE sales_returns SET rev = rev + 1 WHERE id = OLD.return_id;
END;

DROP TRIGGER feed_stock_count_items_ins;

CREATE TRIGGER feed_stock_count_items_ins AFTER INSERT ON stock_count_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = NEW.count_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', NEW.count_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_counts SET rev = rev + 1 WHERE id = NEW.count_id;
END;

DROP TRIGGER feed_stock_count_items_upd;

CREATE TRIGGER feed_stock_count_items_upd AFTER UPDATE ON stock_count_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = NEW.count_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', NEW.count_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_counts SET rev = rev + 1 WHERE id = NEW.count_id;
END;

DROP TRIGGER feed_stock_count_items_del;

CREATE TRIGGER feed_stock_count_items_del AFTER DELETE ON stock_count_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = OLD.count_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', OLD.count_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_counts SET rev = rev + 1 WHERE id = OLD.count_id;
END;

DROP TRIGGER feed_stock_entry_items_ins;

CREATE TRIGGER feed_stock_entry_items_ins AFTER INSERT ON stock_entry_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_entries SET rev = rev + 1 WHERE id = NEW.entry_id;
END;

DROP TRIGGER feed_stock_entry_items_upd;

CREATE TRIGGER feed_stock_entry_items_upd AFTER UPDATE ON stock_entry_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_entries SET rev = rev + 1 WHERE id = NEW.entry_id;
END;

DROP TRIGGER feed_stock_entry_items_del;

CREATE TRIGGER feed_stock_entry_items_del AFTER DELETE ON stock_entry_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = OLD.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', OLD.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE stock_entries SET rev = rev + 1 WHERE id = OLD.entry_id;
END;
