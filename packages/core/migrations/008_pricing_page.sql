-- Giving the pricing screen its own page key.
--
-- The page key `pricing` has rendered the counters screen since v1: there was no
-- pricing screen to point it at. Now there is, so `pricing` means pricing and
-- counters move to `registers`.
--
-- Whoever could see the counters screen keeps seeing it. Without this copy the
-- rename would read as "a page nobody has been granted", and applyUpgrades would
-- hand it out by role template — quietly taking the counters screen away from
-- any custom role the owner had granted it to, and giving it to roles they had
-- not. A page an owner deliberately switched off has visible = 0 and stays off,
-- which is the distinction worth preserving here.
INSERT OR IGNORE INTO role_pages (role_id, page_key, visible)
SELECT role_id, 'registers', visible FROM role_pages WHERE page_key = 'pricing';
