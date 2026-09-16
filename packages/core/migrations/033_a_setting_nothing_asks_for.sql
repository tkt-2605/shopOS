-- `schema_bootstrapped_at`: a row in every shop's settings, read by nothing.
--
-- It is in the owner's database now. No code in this repository writes it and
-- no code reads it -- not `bootstrap.ts`, not `upgrade.ts`, not the startup
-- path, not a report. It is left over from a version that wanted to know when
-- a database had been set up, and the thing that actually answers that question
-- is `schema_migrations`, which carries a row per migration with the time it
-- ran.
--
-- The same argument as `sync_queue` in 030. A setting is a thing a shop can be
-- told about and a support call can be asked about, and one that answers
-- nothing costs somebody an afternoon the first time it looks load-bearing.
--
-- ── Why the applying flag ─────────────────────────────────────────────────
--
-- `settings` is replicated and `feed_settings_del` from 021 fires on DELETE,
-- so without this wrapper every till would raise a deletion of a key that
-- every other till is deleting for itself in the same migration -- a change to
-- carry, a row in `change_feed`, and nothing at the far end that needs it.
-- That is what 029 did before it was wrapped the same way, and it manufactured
-- a conflict on a row nobody had touched.
--
-- The flag is what `sync.ts` sets while it applies somebody else's rows, for
-- exactly this reason: a write that every till performs identically is not
-- news.

UPDATE sync_state SET applying = 1 WHERE id = 1;

DELETE FROM settings WHERE key = 'schema_bootstrapped_at';

UPDATE sync_state SET applying = 0 WHERE id = 1;
