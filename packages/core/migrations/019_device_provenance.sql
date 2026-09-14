-- Provenance: which machine a change came from, and a rev that is always right.
--
-- 001's header has claimed since day one that rev and origin_id are "written but
-- not read until sync ships". Half of that was never true. origin_id has never
-- been written by anything, and rev was bumped by 16 of the 64 UPDATE statements
-- in the service layer -- which is worse than never, because a merge that picked
-- a winner by comparing rev would silently discard every change made through the
-- other 48 and would look like it was working.
--
-- Two things here, and deliberately not a third.
--
-- 1. audit_log gains the device. writeAudit already runs inside the same
--    transaction as every service write, so from this migration onward every
--    change carries the machine that made it. That is the part that cannot be
--    retrofitted: a bill rung up before today can never be attributed to a till,
--    because nothing recorded it. It also makes row-level origin_id recoverable
--    later from the audit trail, which is why this migration does not attempt to
--    backfill 20 tables of it.
--
-- 2. rev is bumped by a trigger instead of by hand. A convention that 48 call
--    sites have to remember is not a convention, it is a list of future bugs --
--    this schema has been proving that for eighteen migrations. A trigger cannot
--    be forgotten by a service written next year.
--
-- The WHEN guard is what makes the two safe together: a statement that already
-- set rev itself (the 16 that were doing it correctly) leaves NEW.rev <> OLD.rev,
-- so the trigger stands down rather than counting the change twice. Recursion is
-- doubly impossible -- SQLite runs with recursive_triggers OFF by default, and
-- even switched on the guard is false on the trigger's own write.
--
-- Not done here: origin_id per row. It is the tiebreaker a last-writer-wins
-- merge needs, and it is only needed when a merge exists. Writing it now would
-- mean touching every INSERT in the service layer for a column nothing reads,
-- which is precisely the mistake being corrected above.

ALTER TABLE audit_log ADD COLUMN device_id TEXT;

CREATE INDEX idx_audit_device ON audit_log(device_id, at);

-- 20 replicated tables; every one of them, with no exceptions to remember.

CREATE TRIGGER bump_rev_attachments AFTER UPDATE ON attachments FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE attachments SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_bills AFTER UPDATE ON bills FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE bills SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_cash_sessions AFTER UPDATE ON cash_sessions FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE cash_sessions SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_categories AFTER UPDATE ON categories FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE categories SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_customer_item_prices AFTER UPDATE ON customer_item_prices FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE customer_item_prices SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_customers AFTER UPDATE ON customers FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE customers SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_documents AFTER UPDATE ON documents FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE documents SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_item_prices AFTER UPDATE ON item_prices FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE item_prices SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_payment_entries AFTER UPDATE ON payment_entries FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE payment_entries SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_price_lists AFTER UPDATE ON price_lists FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE price_lists SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_product_barcodes AFTER UPDATE ON product_barcodes FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE product_barcodes SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_product_units AFTER UPDATE ON product_units FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE product_units SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_products AFTER UPDATE ON products FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE products SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_registers AFTER UPDATE ON registers FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE registers SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_roles AFTER UPDATE ON roles FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE roles SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_sales_returns AFTER UPDATE ON sales_returns FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE sales_returns SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_stock_counts AFTER UPDATE ON stock_counts FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE stock_counts SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_stock_entries AFTER UPDATE ON stock_entries FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE stock_entries SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_suppliers AFTER UPDATE ON suppliers FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE suppliers SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER bump_rev_users AFTER UPDATE ON users FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE users SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;
