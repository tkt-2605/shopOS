-- Indexes the queries were asking for, and a ledger that refuses to be edited.
--
-- ## The indexes
--
-- Each is a foreign-key child column, or a date a screen filters by, that had
-- no index and was being scanned:
--
-- - `stock_entry_items(entry_id)`: sync rewrites a stock entry's lines with
--   DELETE ... WHERE entry_id = ? on every entry it applies.
-- - `sales_return_items(bill_item_id)`, `bill_fulfilments(document_item_id)`,
--   `loyalty_redemptions(loyalty_entry_id)`: SQLite looks up the children of
--   every parent row it deletes, and a bill's lines are deleted and rewritten
--   on every merge. The last also serves `reconcileLoyalty`.
-- - `loyalty_entries(bill_id)`: cancelling a bill and every return look an
--   entry up by its bill.
-- - `bills(amended_from)`: discarding a draft looks for what amends it.
-- - `sales_returns`, `payment_entries`, `stock_entries` by `posting_date`:
--   the reports' date ranges.
-- - `stock_ledger(product_id, id)`: the ledger is replayed, and a product's
--   last cost read, in id order from here on -- the order every till holding
--   the same rows agrees on, where `rowid` was only this database's.
--
-- ## The ledger
--
-- "Ledgers are append-only" was a rule the code kept and the database did
-- not: nothing stopped an UPDATE or a DELETE on `stock_ledger`, and the feed
-- triggers would even have carried one to every other till. Now the database
-- refuses both.
--
-- One column is let through. `balance_qty` is each till's own running total,
-- stamped on a row that replicates, so a copy of a row arriving from another
-- till carries that till's figure -- sync writes arrivals as an upsert, and
-- refusing the difference would quarantine every ledger row sent twice. Every
-- column that says what moved, when, why and at what cost is held.
--
-- Additive: indexes and triggers only; no row an older till writes is refused.

CREATE INDEX idx_stock_entry_items_entry       ON stock_entry_items(entry_id);
CREATE INDEX idx_sales_return_items_bill_item  ON sales_return_items(bill_item_id);
CREATE INDEX idx_bill_fulfilments_document_item ON bill_fulfilments(document_item_id);
CREATE INDEX idx_loyalty_redemptions_entry     ON loyalty_redemptions(loyalty_entry_id);
CREATE INDEX idx_loyalty_entries_bill          ON loyalty_entries(bill_id) WHERE bill_id IS NOT NULL;
CREATE INDEX idx_bills_amended_from            ON bills(amended_from) WHERE amended_from IS NOT NULL;
CREATE INDEX idx_sales_returns_date            ON sales_returns(posting_date);
CREATE INDEX idx_payment_entries_date          ON payment_entries(posting_date);
CREATE INDEX idx_stock_entries_date            ON stock_entries(posting_date);
CREATE INDEX idx_stock_ledger_made             ON stock_ledger(product_id, id);

CREATE TRIGGER stock_ledger_is_append_only_upd BEFORE UPDATE ON stock_ledger FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.qty_change IS NOT OLD.qty_change
  OR NEW.unit_cost IS NOT OLD.unit_cost
  OR NEW.voucher_type IS NOT OLD.voucher_type
  OR NEW.voucher_id IS NOT OLD.voucher_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only: post a reversing movement instead');
END;

CREATE TRIGGER stock_ledger_is_append_only_del BEFORE DELETE ON stock_ledger FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only: post a reversing movement instead');
END;
