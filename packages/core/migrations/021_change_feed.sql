-- The changefeed: what has changed here since a till last asked.
--
-- Phase 1 of docs/multi-device.md. It is the answer to the question sync has to
-- ask, and the alternative to asking it is comparing two whole databases row by
-- row over a shop's wifi, every few minutes, for ever.
--
-- ── Three decisions, because each has a worse version that looks the same ───
--
-- 1. **Triggers, not the service layer.** The plan in docs/multi-device.md said
--    this would be written "by the same service-layer seam that writes the audit
--    row". It cannot be, and the reason is a fact that only came out under
--    review: bootstrap.ts and seed.ts write no audit rows at all, and between
--    them insert into ten of these tables. The audit seam is not the complete
--    set of writes, so a feed hung off it would be missing rows -- and a missing
--    feed row is not a slow sync, it is a row that never replicates and never
--    reports that it did not. 019 made this argument for `rev` and it is
--    stronger here: `rev` being wrong makes a merge pick the wrong winner, and
--    this being wrong makes a merge never see the row at all.
--
-- 2. **A dirty set, not a log.** One row per changed record, replaced each time
--    it changes, rather than one row per change. A till that edits the same
--    price forty times before the other till asks should send one row, not
--    forty, and the receiving side wants the record as it stands rather than a
--    reel of how it got there. So the feed carries no payload: it names what
--    changed, and sync reads the row itself. A payload stored here would be a
--    second copy of the truth, and the whole product is built on there not being
--    one. `seq` is AUTOINCREMENT precisely so it is never reused -- a reused seq
--    silently steps over a row for a till holding that cursor.
--
-- 3. **No `rev` column here**, though it is the obvious thing to store. The
--    `bump_rev_*` triggers from 019 and these fire on the same UPDATE, and
--    SQLite does not define which runs first, so half the time this would record
--    the rev from before the bump. Sync reads the row and gets the rev that is
--    actually on it. A column that is right most of the time is worse than no
--    column, because it is the kind that gets trusted.
--
-- ── Echo ───────────────────────────────────────────────────────────────────
--
-- Applying a change from another till is itself a write, so it lands in this
-- feed, so the other till pulls it back, applies it, and feeds it again. Two
-- tills would pass one row between them for ever, each one doing real work.
--
-- `sync_state.applying` is how a merge says "these writes are not news". Every
-- trigger below checks it. It is a table rather than something in the process
-- because a trigger can only see the database, and it is reset to 0 at startup
-- because a crash halfway through a merge would otherwise leave a till that
-- quietly stops telling anyone anything -- which is this product's own worst
-- failure, a switch that is on and does nothing.
--
-- ── What is in, and what is deliberately out ───────────────────────────────
--
--   own row     the 21 tables carrying `rev`. They are edited in place and are
--               what last-writer-wins is for.
--   own row     stock_ledger, loyalty_entries. Append-only and owned by nobody
--               -- a ledger row is not a line of a product. They merge by union
--               on their id, which needs no `rev` and cannot conflict.
--   own row     doc_formats. The shop's own bill layouts, authored on a screen,
--               and two tills printing different bills is the whole problem.
--               It carries no `rev`, so it travels but has nothing to settle a
--               tie with -- owed, and better owed visibly than left out.
--   parent row  bill_items, bill_payments and the other ten line tables. A bill
--               travels as a bill. Marking the parent means a bill whose lines
--               changed is sent whole, which is the only way it is ever correct.
--
--   OUT: product_stock, doc_sequences. Derived, not authored. A merge
--        recomputes stock from the ledger, and taking either side of a number
--        series would hand two tills the same invoice number -- the one outcome
--        this whole seam exists to prevent.
--   OUT: audit_log, activity_log. History of what this machine did. They are
--        worth replicating one day so a shop can see all its tills in one list,
--        and that is a feature with a screen, not a merge -- it has no conflict
--        to resolve and does not belong in the path that does.
--   OUT: change_feed and sync_state themselves, for the obvious reason.
--
-- No table is excluded by being forgotten: changefeed.test.ts derives the set
-- from the schema and fails when a table is added without a decision here.

CREATE TABLE change_feed (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  -- 'delete' only for a row genuinely removed. A soft delete sets deleted_at,
  -- which is an UPDATE, and travels as one -- the row still exists and the other
  -- till needs to be told it is gone rather than left wondering.
  op         TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  at         TEXT NOT NULL,
  UNIQUE (table_name, row_id)
) STRICT;

CREATE TABLE sync_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  -- 1 while a merge is writing, so its writes are not fed back to the till they
  -- came from. Reset at startup: see the header.
  applying INTEGER NOT NULL DEFAULT 0 CHECK (applying IN (0, 1))
) STRICT;

-- There is deliberately no "how far the other till has read" column here. With
-- one peer it would be a number; with three it is a row per peer, and which of
-- those is right is Phase 2's decision, made when there is something to pair
-- with. A column added now would be one nothing writes, which is the fault this
-- schema keeps being corrected for. `pruneFeed` takes the seq from its caller.

INSERT INTO sync_state (id, applying) VALUES (1, 0);


-- ── rows that replicate as themselves ──────────────────────────────────

CREATE TRIGGER feed_attachments_ins AFTER INSERT ON attachments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'attachments' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('attachments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_attachments_upd AFTER UPDATE ON attachments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'attachments' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('attachments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_attachments_del AFTER DELETE ON attachments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'attachments' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('attachments', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bills_ins AFTER INSERT ON bills FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bills_upd AFTER UPDATE ON bills FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bills_del AFTER DELETE ON bills FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_cash_sessions_ins AFTER INSERT ON cash_sessions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_cash_sessions_upd AFTER UPDATE ON cash_sessions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_cash_sessions_del AFTER DELETE ON cash_sessions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_categories_ins AFTER INSERT ON categories FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'categories' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('categories', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_categories_upd AFTER UPDATE ON categories FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'categories' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('categories', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_categories_del AFTER DELETE ON categories FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'categories' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('categories', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_customer_item_prices_ins AFTER INSERT ON customer_item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customer_item_prices' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('customer_item_prices', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_customer_item_prices_upd AFTER UPDATE ON customer_item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customer_item_prices' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('customer_item_prices', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_customer_item_prices_del AFTER DELETE ON customer_item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customer_item_prices' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('customer_item_prices', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_customers_ins AFTER INSERT ON customers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customers' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('customers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_customers_upd AFTER UPDATE ON customers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customers' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('customers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_customers_del AFTER DELETE ON customers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'customers' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('customers', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_documents_ins AFTER INSERT ON documents FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_documents_upd AFTER UPDATE ON documents FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_documents_del AFTER DELETE ON documents FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_item_prices_ins AFTER INSERT ON item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'item_prices' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('item_prices', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_item_prices_upd AFTER UPDATE ON item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'item_prices' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('item_prices', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_item_prices_del AFTER DELETE ON item_prices FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'item_prices' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('item_prices', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_payment_entries_ins AFTER INSERT ON payment_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_payment_entries_upd AFTER UPDATE ON payment_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_payment_entries_del AFTER DELETE ON payment_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_price_lists_ins AFTER INSERT ON price_lists FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'price_lists' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('price_lists', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_price_lists_upd AFTER UPDATE ON price_lists FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'price_lists' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('price_lists', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_price_lists_del AFTER DELETE ON price_lists FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'price_lists' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('price_lists', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_barcodes_ins AFTER INSERT ON product_barcodes FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_barcodes' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_barcodes', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_barcodes_upd AFTER UPDATE ON product_barcodes FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_barcodes' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_barcodes', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_barcodes_del AFTER DELETE ON product_barcodes FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_barcodes' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_barcodes', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_units_ins AFTER INSERT ON product_units FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_units' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_units', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_units_upd AFTER UPDATE ON product_units FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_units' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_units', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_units_del AFTER DELETE ON product_units FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_units' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_units', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_products_ins AFTER INSERT ON products FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'products' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('products', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_products_upd AFTER UPDATE ON products FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'products' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('products', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_products_del AFTER DELETE ON products FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'products' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('products', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_registers_ins AFTER INSERT ON registers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'registers' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('registers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_registers_upd AFTER UPDATE ON registers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'registers' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('registers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_registers_del AFTER DELETE ON registers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'registers' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('registers', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_roles_ins AFTER INSERT ON roles FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_roles_upd AFTER UPDATE ON roles FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_roles_del AFTER DELETE ON roles FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_sales_returns_ins AFTER INSERT ON sales_returns FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_sales_returns_upd AFTER UPDATE ON sales_returns FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_sales_returns_del AFTER DELETE ON sales_returns FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_settings_ins AFTER INSERT ON settings FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'settings' AND row_id = NEW.key;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('settings', NEW.key, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_settings_upd AFTER UPDATE ON settings FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'settings' AND row_id = NEW.key;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('settings', NEW.key, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_settings_del AFTER DELETE ON settings FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'settings' AND row_id = OLD.key;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('settings', OLD.key, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_counts_ins AFTER INSERT ON stock_counts FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_counts_upd AFTER UPDATE ON stock_counts FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_counts_del AFTER DELETE ON stock_counts FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_entries_ins AFTER INSERT ON stock_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_entries_upd AFTER UPDATE ON stock_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_entries_del AFTER DELETE ON stock_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_suppliers_ins AFTER INSERT ON suppliers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'suppliers' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('suppliers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_suppliers_upd AFTER UPDATE ON suppliers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'suppliers' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('suppliers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_suppliers_del AFTER DELETE ON suppliers FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'suppliers' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('suppliers', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_users_ins AFTER INSERT ON users FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'users' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('users', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_users_upd AFTER UPDATE ON users FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'users' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('users', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_users_del AFTER DELETE ON users FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'users' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('users', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_ledger_ins AFTER INSERT ON stock_ledger FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_ledger' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_ledger', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_ledger_upd AFTER UPDATE ON stock_ledger FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_ledger' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_ledger', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_ledger_del AFTER DELETE ON stock_ledger FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_ledger' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_ledger', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_loyalty_entries_ins AFTER INSERT ON loyalty_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'loyalty_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('loyalty_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_loyalty_entries_upd AFTER UPDATE ON loyalty_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'loyalty_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('loyalty_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_loyalty_entries_del AFTER DELETE ON loyalty_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'loyalty_entries' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('loyalty_entries', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_doc_formats_ins AFTER INSERT ON doc_formats FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'doc_formats' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('doc_formats', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_doc_formats_upd AFTER UPDATE ON doc_formats FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'doc_formats' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('doc_formats', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_doc_formats_del AFTER DELETE ON doc_formats FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'doc_formats' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('doc_formats', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;


-- ── lines, which travel as the document they are lines of ─────────────

CREATE TRIGGER feed_bill_items_ins AFTER INSERT ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_items_upd AFTER UPDATE ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_items_del AFTER DELETE ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_payments_ins AFTER INSERT ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_payments_upd AFTER UPDATE ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_payments_del AFTER DELETE ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_fulfilments_ins AFTER INSERT ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_fulfilments_upd AFTER UPDATE ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_fulfilments_del AFTER DELETE ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_loyalty_redemptions_ins AFTER INSERT ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_loyalty_redemptions_upd AFTER UPDATE ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_loyalty_redemptions_del AFTER DELETE ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_payment_allocations_ins AFTER INSERT ON payment_allocations FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = NEW.payment_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', NEW.payment_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_payment_allocations_upd AFTER UPDATE ON payment_allocations FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = NEW.payment_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', NEW.payment_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_payment_allocations_del AFTER DELETE ON payment_allocations FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'payment_entries' AND row_id = OLD.payment_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('payment_entries', OLD.payment_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_document_items_ins AFTER INSERT ON document_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = NEW.document_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', NEW.document_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_document_items_upd AFTER UPDATE ON document_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = NEW.document_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', NEW.document_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_document_items_del AFTER DELETE ON document_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'documents' AND row_id = OLD.document_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('documents', OLD.document_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_cash_movements_ins AFTER INSERT ON cash_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = NEW.session_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', NEW.session_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_cash_movements_upd AFTER UPDATE ON cash_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = NEW.session_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', NEW.session_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_cash_movements_del AFTER DELETE ON cash_movements FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'cash_sessions' AND row_id = OLD.session_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('cash_sessions', OLD.session_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_role_pages_ins AFTER INSERT ON role_pages FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_role_pages_upd AFTER UPDATE ON role_pages FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_role_pages_del AFTER DELETE ON role_pages FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = OLD.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', OLD.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_role_permissions_ins AFTER INSERT ON role_permissions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_role_permissions_upd AFTER UPDATE ON role_permissions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = NEW.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', NEW.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_role_permissions_del AFTER DELETE ON role_permissions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'roles' AND row_id = OLD.role_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('roles', OLD.role_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_sales_return_items_ins AFTER INSERT ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_sales_return_items_upd AFTER UPDATE ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = NEW.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', NEW.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_sales_return_items_del AFTER DELETE ON sales_return_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'sales_returns' AND row_id = OLD.return_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('sales_returns', OLD.return_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_count_items_ins AFTER INSERT ON stock_count_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = NEW.count_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', NEW.count_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_count_items_upd AFTER UPDATE ON stock_count_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = NEW.count_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', NEW.count_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_count_items_del AFTER DELETE ON stock_count_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_counts' AND row_id = OLD.count_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_counts', OLD.count_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_entry_items_ins AFTER INSERT ON stock_entry_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_entry_items_upd AFTER UPDATE ON stock_entry_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = NEW.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', NEW.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_stock_entry_items_del AFTER DELETE ON stock_entry_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'stock_entries' AND row_id = OLD.entry_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('stock_entries', OLD.entry_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
