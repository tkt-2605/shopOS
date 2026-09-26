-- Checks the tables were built without, added as triggers.
--
-- Columns added later by ALTER TABLE could not take a CHECK -- SQLite allows
-- one on a new column but the project's rule is that tightening a CHECK means
-- rebuilding the table, and a rebuild is a breaking migration. So these are
-- BEFORE triggers, which refuse the same rows a CHECK would and are additive:
-- a row an older till writes is either fine or was already wrong.
--
-- - Flags that are yes or no: `products.loyalty_blocked`,
--   `bill_items.discount_blocked`, `bill_items.loyalty_blocked`,
--   `bills.reverse_charge`.
-- - Totals and counts that cannot go below zero: a bill's subtotal, tax,
--   grand and paid totals; a return's refunds and points; a product's reorder
--   figures; a drawer's opening cash; a counted quantity.
-- - Business dates that are dates: `posting_date` on every document is read
--   as text and compared as text by every report, so a value that is not
--   `YYYY-MM-DD` sorts somewhere nonsensical and is counted in the wrong day.
--
-- They fire for rows arriving by sync as well, so a bad row from elsewhere is
-- set aside in quarantine rather than merged.
--
-- Folded into real CHECKs whenever each table is next rebuilt.

CREATE TRIGGER check_products_ins BEFORE INSERT ON products FOR EACH ROW
WHEN NEW.loyalty_blocked NOT IN (0, 1)
  OR COALESCE(NEW.reorder_level, 0) < 0 OR COALESCE(NEW.reorder_qty, 0) < 0
BEGIN SELECT RAISE(ABORT, 'products: a flag is 0 or 1 and a reorder figure is not negative'); END;
CREATE TRIGGER check_products_upd BEFORE UPDATE ON products FOR EACH ROW
WHEN NEW.loyalty_blocked NOT IN (0, 1)
  OR COALESCE(NEW.reorder_level, 0) < 0 OR COALESCE(NEW.reorder_qty, 0) < 0
BEGIN SELECT RAISE(ABORT, 'products: a flag is 0 or 1 and a reorder figure is not negative'); END;

CREATE TRIGGER check_bill_items_ins BEFORE INSERT ON bill_items FOR EACH ROW
WHEN NEW.discount_blocked NOT IN (0, 1) OR NEW.loyalty_blocked NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'bill_items: a flag is 0 or 1'); END;
CREATE TRIGGER check_bill_items_upd BEFORE UPDATE ON bill_items FOR EACH ROW
WHEN NEW.discount_blocked NOT IN (0, 1) OR NEW.loyalty_blocked NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'bill_items: a flag is 0 or 1'); END;

CREATE TRIGGER check_bills_ins BEFORE INSERT ON bills FOR EACH ROW
WHEN NEW.reverse_charge NOT IN (0, 1)
  OR NEW.subtotal < 0 OR NEW.tax_total < 0 OR NEW.grand_total < 0 OR NEW.paid_total < 0
  OR NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'bills: totals are not negative and posting_date is YYYY-MM-DD'); END;
CREATE TRIGGER check_bills_upd BEFORE UPDATE ON bills FOR EACH ROW
WHEN NEW.reverse_charge NOT IN (0, 1)
  OR NEW.subtotal < 0 OR NEW.tax_total < 0 OR NEW.grand_total < 0 OR NEW.paid_total < 0
  OR NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'bills: totals are not negative and posting_date is YYYY-MM-DD'); END;

CREATE TRIGGER check_sales_returns_ins BEFORE INSERT ON sales_returns FOR EACH ROW
WHEN NEW.refund_total < 0 OR NEW.refund_cash < 0 OR NEW.points_restored < 0 OR NEW.points_removed < 0
  OR NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'sales_returns: refunds and points are not negative and posting_date is YYYY-MM-DD'); END;
CREATE TRIGGER check_sales_returns_upd BEFORE UPDATE ON sales_returns FOR EACH ROW
WHEN NEW.refund_total < 0 OR NEW.refund_cash < 0 OR NEW.points_restored < 0 OR NEW.points_removed < 0
  OR NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'sales_returns: refunds and points are not negative and posting_date is YYYY-MM-DD'); END;

CREATE TRIGGER check_payment_entries_ins BEFORE INSERT ON payment_entries FOR EACH ROW
WHEN NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'payment_entries: posting_date is YYYY-MM-DD'); END;
CREATE TRIGGER check_payment_entries_upd BEFORE UPDATE ON payment_entries FOR EACH ROW
WHEN NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'payment_entries: posting_date is YYYY-MM-DD'); END;

CREATE TRIGGER check_stock_entries_ins BEFORE INSERT ON stock_entries FOR EACH ROW
WHEN NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'stock_entries: posting_date is YYYY-MM-DD'); END;
CREATE TRIGGER check_stock_entries_upd BEFORE UPDATE ON stock_entries FOR EACH ROW
WHEN NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'stock_entries: posting_date is YYYY-MM-DD'); END;

CREATE TRIGGER check_documents_ins BEFORE INSERT ON documents FOR EACH ROW
WHEN NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'documents: posting_date is YYYY-MM-DD'); END;
CREATE TRIGGER check_documents_upd BEFORE UPDATE ON documents FOR EACH ROW
WHEN NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'documents: posting_date is YYYY-MM-DD'); END;

CREATE TRIGGER check_stock_ledger_ins BEFORE INSERT ON stock_ledger FOR EACH ROW
WHEN NEW.posting_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN SELECT RAISE(ABORT, 'stock_ledger: posting_date is YYYY-MM-DD'); END;

CREATE TRIGGER check_cash_sessions_ins BEFORE INSERT ON cash_sessions FOR EACH ROW
WHEN NEW.opening_cash < 0
BEGIN SELECT RAISE(ABORT, 'cash_sessions: opening cash is not negative'); END;
CREATE TRIGGER check_cash_sessions_upd BEFORE UPDATE ON cash_sessions FOR EACH ROW
WHEN NEW.opening_cash < 0
BEGIN SELECT RAISE(ABORT, 'cash_sessions: opening cash is not negative'); END;

CREATE TRIGGER check_stock_count_items_ins BEFORE INSERT ON stock_count_items FOR EACH ROW
WHEN COALESCE(NEW.counted_qty, 0) < 0
BEGIN SELECT RAISE(ABORT, 'stock_count_items: a count is not negative'); END;
CREATE TRIGGER check_stock_count_items_upd BEFORE UPDATE ON stock_count_items FOR EACH ROW
WHEN COALESCE(NEW.counted_qty, 0) < 0
BEGIN SELECT RAISE(ABORT, 'stock_count_items: a count is not negative'); END;
