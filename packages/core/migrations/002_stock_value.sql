-- Running stock value, so a sale can record what the goods cost without replaying
-- the whole ledger at the counter.
--
-- The VALUE is stored and the RATE is derived, not the other way round. An integer
-- rate per unit would round on every movement and drift away from what was actually
-- paid; a total in paise is exact, and the rate falls out of it on demand.

ALTER TABLE product_stock ADD COLUMN stock_value INTEGER NOT NULL DEFAULT 0;

-- Backfill from the ledger it is a cache of. Without this an existing shop starts
-- at zero, every sale is stamped with no cost, and the profit report silently reads
-- 100% margin until someone runs a recompute — a default of 0 is not a neutral
-- starting point for a running total.
--
-- Quantities are scaled by 10,000 (see quantity.ts), so dividing by that converts
-- a scaled quantity times a paise rate back into paise.
UPDATE product_stock
   SET stock_value = CASE
     WHEN qty_on_hand <= 0 THEN 0
     ELSE MAX(0, COALESCE((
       SELECT SUM(CAST(ROUND(sl.qty_change * sl.unit_cost / 10000.0) AS INTEGER))
         FROM stock_ledger sl
        WHERE sl.product_id = product_stock.product_id
          AND sl.unit_cost IS NOT NULL
     ), 0))
   END;
