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
-- Additive. A setting and not a figure: 0 is what every item already is, and
-- a copy relayed by an older till that loses the flag bills at the item's own
-- rate like any other, with nothing on a bill or in the books reading
-- differently. See `REVIEWED_DEFAULTS`.

ALTER TABLE products ADD COLUMN open_price INTEGER NOT NULL DEFAULT 0
  CHECK (open_price IN (0, 1));
