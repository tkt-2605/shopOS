-- How far this till has forgotten its own change feed.
--
-- `pruneAcknowledged` used to prune only as far as the slowest peer had read,
-- and a peer is forgotten only when a person says so. So one phone put in a
-- drawer, or a cloud replica that is paired and never reached, held every
-- till's feed where it was for the life of the shop: it grew, every round read
-- more of it, and nothing said why.
--
-- Pruning now leaves out a peer not heard from in thirty days, and this column
-- is what makes that safe: it records how far the feed has been pruned, so a
-- peer that comes back asking from below it is known to have missed entries,
-- and is given the whole shop again rather than silently less of it.
--
-- Backfilled with the lowest cursor any peer holds, which is at or above
-- everything pruned so far: cursors only rise, and pruning never went past the
-- lowest. Overstating it costs one unnecessary re-send to a peer below it, and
-- there is no such peer.
--
-- Additive: a column on a table that never travels.

ALTER TABLE sync_state ADD COLUMN pruned_through INTEGER NOT NULL DEFAULT 0;

UPDATE sync_state
   SET pruned_through = COALESCE((SELECT MIN(my_cursor) FROM sync_peers), 0);
