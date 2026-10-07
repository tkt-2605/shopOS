-- An item whose price is typed at the counter, every time it is sold.
--
-- A stationery shop sells a handful of loose clips, a few sheets cut from a
-- roll, a bundle of oddments nobody will catalogue. The billing machine it
-- had before carried one item for all of it -- "Loose item" -- that asked for
-- an amount and kept no stock, so the day's loose sales still added up to a
-- figure somebody could read.
--
-- Here, typing a rate is a price decision and takes `price_list.write`, which
-- a cashier rightly does not have: it lets them reprice every item on every
-- bill. `open_price` marks the one item where typing the amount *is* the
-- price, so the counter asks for it on adding the line, any cashier may give
-- it, and a bill refuses the line at nothing rather than letting a forgotten
-- amount go through as a free sale.
--
-- Breaking, though the rows would cross: a till without this column holds the
-- loose item as an ordinary item at nothing, and bills it at nothing. Shipped
-- as additive in 0.2.6 and corrected in 0.2.7. See `migrationKinds.ts`.

ALTER TABLE products ADD COLUMN open_price INTEGER NOT NULL DEFAULT 0
  CHECK (open_price IN (0, 1));
