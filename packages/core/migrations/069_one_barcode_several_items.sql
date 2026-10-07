-- One barcode on several items, the scan asking which.
--
-- Since 007 a barcode belonged to one item, and the database held it to that:
-- a scan that could mean two things was judged worse than a scan that means
-- nothing. A manufacturer does not agree. The same EAN goes on two pack sizes,
-- or two shades, and a shop that keeps them as two items -- two prices, two
-- shelves to count -- could give only one of them its code. The other was
-- found by name, at the counter, with a queue.
--
-- So a code may sit on several items, and a scan that finds more than one
-- shows them, price first, for the cashier to choose. Nothing is chosen for
-- them: every screen that turns a scan into an item asks.
--
-- The index stays, for the scan's sake, without the UNIQUE. Nothing replaces it
-- on (product_id, barcode): `setBarcodes` keeps an item from holding one code
-- twice, and a database rule there would turn two tills that each put the code
-- back on an item while apart into a sync that cannot finish. A repeated row on
-- one item scans as that one item all the same.
--
-- Breaking. A till below this still holds the code unique, and the second
-- item's row would stop its sync partway through a batch.

DROP INDEX idx_product_barcodes_code;
CREATE INDEX idx_product_barcodes_code ON product_barcodes (barcode);
