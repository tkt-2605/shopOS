-- Which till is the main, and how many times the main has changed.
--
-- Every till used to be the equal of every other: any of them could answer,
-- pair and relay. From here a shop syncs through one main -- a till on the
-- LAN, or the cloud while it is paid -- and the others join it and dial it.
-- `docs/specs/one-main-till.md` carries the argument.
--
-- `main_epoch` is raised by one at every change of main and travels in every
-- hello. A till follows the highest it has heard, so a main that comes back
-- after a repair, still believing it is the main, hears a higher number on
-- first contact and steps down. It is Raft's term under another name.
--
-- On `sync_state` and not in `settings`, because `settings` replicates and
-- merges by last writer: it would let a lower epoch overwrite a higher one,
-- which is the one thing this number exists to prevent.
--
-- No backfill. A shop already paired has no main recorded and goes on as it
-- was, every till equal; a shop with one till becomes the main the first time
-- it lets another in.
--
-- Additive: columns on a table that never travels.

ALTER TABLE sync_state ADD COLUMN main_device TEXT;
ALTER TABLE sync_state ADD COLUMN main_epoch INTEGER NOT NULL DEFAULT 0;
