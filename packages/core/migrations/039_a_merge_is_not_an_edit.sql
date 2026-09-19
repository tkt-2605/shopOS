-- A merge stops handing out free revisions.
--
-- ── What was wrong ────────────────────────────────────────────────────────
--
-- 022 states the invariant plainly: "bumping it here would make this copy look
-- newer than the machine the change came from". The feed triggers from 021 were
-- built around it — every one of them stands down while `sync_state.applying` is
-- 1, so a row this till writes because another till sent it is not fed back as
-- news. The `bump_rev_*` triggers were written three migrations earlier and
-- never got the same guard.
--
-- So applying somebody else's row raised its revision here. Not always: the
-- trigger only fires `WHEN NEW.rev = OLD.rev`, so it stays quiet whenever the
-- arriving revision differs from the one held. It fires in exactly the case
-- that matters — both tills at the same revision, one of them winning on the
-- timestamp — and the winner's row lands on the loser one revision *higher*
-- than the till it came from.
--
-- The shop that produces: two counters holding byte-identical rows that
-- disagree about which is newer. Nothing is wrong on either screen, and the
-- next edit at the till with the lower number loses to a copy of itself. On a
-- ring of four tills the row never stops moving — `converges.test.ts` finds it
-- as `products/... rev: till 0 has 4, they have 3` and then as a shop that
-- never goes quiet.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
-- The same 22 triggers, with the `applying` guard the feed triggers have had
-- since 021. `WHEN NEW.rev = OLD.rev` stays: it is what stops a statement that
-- set `rev` itself from being counted twice, and the two conditions answer
-- different questions — *did somebody already number this change*, and *is this
-- a change at all or the echo of one*.
--
-- ── One idiom this retires ────────────────────────────────────────────────
--
-- 029 brackets its write with `applying = 1` and then puts `rev` back by hand:
--
--     UPDATE doc_formats SET rev = rev - 1 WHERE id = 'standard_receipt';
--
-- It needed to, because the bump fired through the bracket. From here it does
-- not, and a migration that copies that shape would take a revision *below*
-- where it started. 029 itself is unaffected — it runs before this file on
-- every database, upgraded or fresh, so it meets the old triggers either way,
-- which is also why this migration has nothing to repair.
--
-- Additive: the rows, columns and trigger names are all unchanged, so a till on
-- either side of it still syncs with one on the other. What differs is which
-- till ends up one revision ahead, and only in the case where they were level.

DROP TRIGGER bump_rev_attachments;
CREATE TRIGGER bump_rev_attachments AFTER UPDATE ON attachments FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE attachments SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_bills;
CREATE TRIGGER bump_rev_bills AFTER UPDATE ON bills FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE bills SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_cash_sessions;
CREATE TRIGGER bump_rev_cash_sessions AFTER UPDATE ON cash_sessions FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE cash_sessions SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_categories;
CREATE TRIGGER bump_rev_categories AFTER UPDATE ON categories FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE categories SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_customer_item_prices;
CREATE TRIGGER bump_rev_customer_item_prices AFTER UPDATE ON customer_item_prices FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE customer_item_prices SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_customers;
CREATE TRIGGER bump_rev_customers AFTER UPDATE ON customers FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE customers SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_documents;
CREATE TRIGGER bump_rev_documents AFTER UPDATE ON documents FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE documents SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_doc_formats;
CREATE TRIGGER bump_rev_doc_formats AFTER UPDATE ON doc_formats FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE doc_formats SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_item_prices;
CREATE TRIGGER bump_rev_item_prices AFTER UPDATE ON item_prices FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE item_prices SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_payment_entries;
CREATE TRIGGER bump_rev_payment_entries AFTER UPDATE ON payment_entries FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE payment_entries SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_price_lists;
CREATE TRIGGER bump_rev_price_lists AFTER UPDATE ON price_lists FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE price_lists SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_product_barcodes;
CREATE TRIGGER bump_rev_product_barcodes AFTER UPDATE ON product_barcodes FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE product_barcodes SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_product_units;
CREATE TRIGGER bump_rev_product_units AFTER UPDATE ON product_units FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE product_units SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_products;
CREATE TRIGGER bump_rev_products AFTER UPDATE ON products FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE products SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_registers;
CREATE TRIGGER bump_rev_registers AFTER UPDATE ON registers FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE registers SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_roles;
CREATE TRIGGER bump_rev_roles AFTER UPDATE ON roles FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE roles SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_sales_returns;
CREATE TRIGGER bump_rev_sales_returns AFTER UPDATE ON sales_returns FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE sales_returns SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_settings;
CREATE TRIGGER bump_rev_settings AFTER UPDATE ON settings FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE settings SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_stock_counts;
CREATE TRIGGER bump_rev_stock_counts AFTER UPDATE ON stock_counts FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE stock_counts SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_stock_entries;
CREATE TRIGGER bump_rev_stock_entries AFTER UPDATE ON stock_entries FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE stock_entries SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_suppliers;
CREATE TRIGGER bump_rev_suppliers AFTER UPDATE ON suppliers FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE suppliers SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

DROP TRIGGER bump_rev_users;
CREATE TRIGGER bump_rev_users AFTER UPDATE ON users FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE users SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;
