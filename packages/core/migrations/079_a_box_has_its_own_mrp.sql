-- A box has a price and an MRP of its own, behind a switch.
--
-- A pen is ₹10 and its box of ten is printed ₹90. Until now the item carried
-- one MRP, per piece, and a box line showed ten times it; and a box's own
-- selling price could be kept (a rate on the shop's own list in the box unit)
-- but since Special Prices was made plain on 24 October there was no screen
-- left that showed it. Both now sit on the unit's row of the item form, when
-- "Box prices and MRP" is on in Settings.
--
-- `product_units.mrp` is paise per one of that unit, as printed on it. Null is
-- none printed, and the box reads as its pieces' MRP times how many it holds.
--
-- The switch starts on for a shop already pricing a unit for everyone, so a
-- box that charges ₹110 today goes on charging it and can now be seen; every
-- other shop starts with it off. Off, the box price and MRP are kept and not
-- used (`repos/pricing.ts`, `services/billing/price.ts`) -- the same rule as
-- quantity breaks: a price nobody can see must not be charged.
--
-- Breaking: the column changes what a till prints as a box line's MRP, and a
-- unit row passed on by a till below 079 would arrive without it and wipe the
-- box MRP a person typed.

ALTER TABLE product_units ADD COLUMN mrp INTEGER CHECK (mrp IS NULL OR mrp >= 0);

-- Seeded inside the `applying` bracket, as 043 seeds the default list: every
-- till works this out the same from the same rows, and feeding it would make a
-- conflict out of a setting nobody touched.
UPDATE sync_state SET applying = 1 WHERE id = 1;

INSERT INTO settings (key, value, updated_at)
SELECT 'feature_unit_prices',
       CASE WHEN EXISTS (
         SELECT 1 FROM item_prices ip
           JOIN products p ON p.id = ip.product_id
          WHERE ip.deleted_at IS NULL
            AND ip.sale_unit <> p.base_unit
            AND ip.price_list_id = (SELECT value FROM settings WHERE key = 'default_price_list_id')
       ) THEN 'on' ELSE 'off' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'feature_unit_prices');

UPDATE sync_state SET applying = 0 WHERE id = 1;
