-- A barcode or a sale unit taken off an item is marked gone, not removed.
--
-- 041 gave bill layouts `deleted_at` and left these two with a hard delete,
-- on the argument that a deterministic id stops a save from deleting a row
-- and minting another. It does, for a set saved unchanged. It does not for a
-- barcode or unit actually taken off: that is still a delete, its tombstone is
-- a change-feed row pruned once every peer has read it, and round a ring of
-- three or more tills a delete and a till that has not heard of it take turns
-- -- 041 describes it. For a barcode that is not cosmetic: a code resurrected
-- on the third till scans as an item the shop took it off.
--
-- So removal is an edit: `deleted_at` is set, `rev` settles it like any other
-- change, and nothing is left for a till that has not heard to offer back.
-- The ids are derived (a barcode from its code, a unit from its product and
-- name), so putting one back revives the same row rather than meeting a
-- UNIQUE it cannot see.
--
-- Additive: one nullable column on each. A till below this ignores it and
-- keeps the barcode, which is the older behaviour and not a wrong figure.

ALTER TABLE product_barcodes ADD COLUMN deleted_at TEXT;
ALTER TABLE product_units ADD COLUMN deleted_at TEXT;
