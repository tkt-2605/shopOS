-- What each migration said when it ran on this till.
--
-- A database records only how far it has migrated (`PRAGMA user_version`),
-- never what those migrations contained. A migration edited after a till had
-- run it -- a local build tried on a shop, then changed before release --
-- leaves that till with a schema the released code does not describe, and
-- nothing anywhere notices. `checkMigrationSums` (`db/migrate.ts`) keeps a
-- SHA-256 of each migration's statements here the first time it sees it, and
-- names any whose text has changed since; the app writes that to its log,
-- which goes out with the health report. It never stops the till.
--
-- Additive: a new table that stays on this till.

CREATE TABLE migration_sums (
  version     INTEGER PRIMARY KEY,
  sum         TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;
