-- Which till a ledger row's running balance belongs to.
--
-- `balance_qty` is the shelf count on the till that wrote the row, at the
-- moment it wrote it. Two tills that have merged never shared one, and the
-- row did not say which till it came from -- so a product's history showed
-- another counter's running total as if it were this one's shelf, and the
-- two columns of numbers could not be read against each other.
--
-- `device_id` is the machine that posted the movement. The history shows a
-- balance only for this till's own rows, and for rows from before this, which
-- carry no device and read as they always did.
--
-- The append-only guard from 052/058 learns the column the way it learned
-- `value_change`: once set it does not change; a row that arrived from a till
-- below this may be given one when a newer till's copy arrives.
--
-- Additive: one nullable column and a trigger rebuilt.

ALTER TABLE stock_ledger ADD COLUMN device_id TEXT;

DROP TRIGGER stock_ledger_is_append_only_upd;
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
  OR (OLD.value_change IS NOT NULL AND NEW.value_change IS NOT OLD.value_change)
  OR (OLD.device_id IS NOT NULL AND NEW.device_id IS NOT OLD.device_id)
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only: post a reversing movement instead');
END;
