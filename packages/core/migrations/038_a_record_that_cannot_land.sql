-- A record that cannot be applied, kept instead of thrown away.
--
-- ── What was wrong ────────────────────────────────────────────────────────
--
-- `mergeBatch` applied a whole batch inside one transaction. `upsert` names the
-- primary key as its conflict target and nothing else, so a row violating any
-- *other* constraint threw, and the throw rolled back the batch that carried it.
-- The cursor never moved. `collectChanges` then rebuilt the identical batch on
-- the next round, which failed identically, every forty-five seconds, for ever —
-- and reported it as a failure to reach the other till, which is a shopkeeper
-- looking at their router about a fault in their data.
--
-- Twenty-two constraints on replicated tables are unique on something other than
-- the primary key, and two tills that have been out of touch can violate most of
-- them by both doing something perfectly reasonable. The likeliest is two
-- counters pricing the same item: `UNIQUE (product_id, price_list_id, sale_unit,
-- min_qty)`, two ids, one row's worth of meaning.
--
-- Removing the causes is worth doing and is a different migration. This is the
-- part that has to be true anyway: **one record that cannot land must not stop
-- the ones behind it.** Every log-shipping replicator ends up here — Kafka
-- Connect's dead-letter topic, `ALTER SUBSCRIPTION ... SKIP` in Postgres,
-- `replica_skip_errors` in MySQL — and every one of them added it after an
-- outage rather than before.
--
-- ── Why this one holds a payload, when the feed refuses to ────────────────
--
-- 021 is emphatic that `change_feed` stores no copy of a row, because "a payload
-- stored here would be a second copy of the truth, and the whole product is built
-- on there not being one". That argument is right and it does not reach here.
--
-- The feed names rows this database *has*. This names a row it does not have and
-- now never will: once the cursor steps over the record, the sending till prunes
-- its own feed entry and nothing will ever mention that row again unless somebody
-- happens to edit it. So the choice is not between one copy and two. It is
-- between keeping the only copy and losing it silently, which is the one outcome
-- worse than the stall this replaces.
--
-- It is a set rather than a log, for 021's other reason: one row per record, so a
-- row that keeps failing is one entry with the latest reason on it rather than a
-- table that grows every forty-five seconds.
--
-- Does not replicate. Like `sync_conflicts`, it is this machine's account of what
-- it could not take from another, and the other till has nothing to learn from
-- it. Declared in `NOT_REPLICATED` for the same reason.

CREATE TABLE sync_quarantine (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  -- The till whose batch carried it. Not necessarily where the row was written:
  -- a relayed record is attributed to the machine in the middle. See `origin`.
  peer_device  TEXT,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  op           TEXT NOT NULL,
  -- What SQLite said, or `parent quarantined` for a record whose foreign key
  -- points at one that did not land. Kept verbatim: the constraint's name is the
  -- whole of the diagnosis, and a sentence written for a screen would lose it.
  reason       TEXT NOT NULL,
  -- The record as it arrived, row and lines, as JSON. The only copy there is.
  record       TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
  -- One entry per record, replaced when it fails again rather than added to.
  UNIQUE (table_name, row_id)
) STRICT;

CREATE INDEX idx_sync_quarantine_at ON sync_quarantine(acknowledged, at);
