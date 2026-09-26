-- What a stock movement was worth, stored rather than worked out again.
--
-- The rule is that valuation stores value and derives rate (002). The ledger
-- did the reverse: each movement kept a rate, and every report multiplied it
-- back by the quantity and rounded, row by row. For goods leaving, the value
-- that actually left is what the running value fell by -- which with a zero
-- floor, or a rate that does not divide evenly, is not the rate times the
-- quantity rounded. So `value_change` is written by `postMovement` as the
-- signed change in the product's stock value, in paise, and a report reads it.
--
-- Backfilled for movements already made as the rate times the quantity,
-- rounded -- the figure every report showed for them until now -- with the
-- change feed standing down: each till works out the same number from the
-- same row, and sending every ledger row round the shop again to say so
-- would be a day's sync for nothing.
--
-- The append-only guard from 052 learns the column: once set it does not
-- change. A row that arrived from a till below this carries no value and may
-- be given one when a newer till's copy arrives; that is the only change let
-- through.
--
-- Additive: one nullable column, a backfill of it, and a trigger rebuilt.

ALTER TABLE stock_ledger ADD COLUMN value_change INTEGER;

UPDATE sync_state SET applying = 1 WHERE id = 1;
UPDATE stock_ledger
   SET value_change = CAST(ROUND(qty_change * unit_cost / 10000.0) AS INTEGER)
 WHERE unit_cost IS NOT NULL;
UPDATE sync_state SET applying = 0 WHERE id = 1;

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
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only: post a reversing movement instead');
END;
