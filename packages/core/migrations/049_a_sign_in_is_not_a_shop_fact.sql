-- Where a sign-in is recorded, so that two tills do not argue about one.
--
-- ── What was wrong ────────────────────────────────────────────────────────
--
-- `login` wrote `last_login_at`, `failed_logins` and `updated_at` on the `users`
-- row, and `users` replicates. So signing in raised the row's revision and
-- queued it for every peer.
--
-- Two counters switched on within one sync round of each other -- 45 seconds,
-- which is what opening time looks like -- each bumped the row before either had
-- told the other. `decideRow` sets `contested` when both sides changed since
-- they last agreed, so that is a filed conflict, every morning, saying "an edit
-- is being dropped". The dropped edit is a login timestamp. Nothing is lost
-- except the usefulness of `sync_conflicts`, which is the table a shopkeeper
-- reads on the day a real edit goes missing, and which four of the nine
-- conflicts on the bench tills were this.
--
-- The deeper fault is not the noise. `users` was carrying two kinds of column
-- under one merge rule:
--
--   * `username`, `password_hash`, `role_id`, `is_active` are edited by a person,
--     deliberately and rarely, on one till. Last-writer-wins is right for them.
--   * `last_login_at` wants the *later* of two values, which LWW gives only when
--     the clocks agree and the write order happens to match. A till running slow
--     writes an older timestamp later and wins.
--   * `failed_logins` is a counter, and LWW on a counter is simply wrong: three
--     wrong guesses at the front counter and two at the back settle to three,
--     never five. `auth.ts` already knew this -- it increments in SQL rather
--     than from the value it read, because "two tills signing in as the same
--     user would otherwise both write the same value and lose a count". That
--     reasoning is about two writers on one database. Across two databases the
--     merge lost the count anyway.
--
-- So the `N failed` badge on the Staff screen could under-report a run of
-- guesses spread across counters, which is the one thing it is on screen for.
--
-- ── What this does ────────────────────────────────────────────────────────
--
-- One row per user per till. The id is derived from exactly that pair
-- (`derivedId`, RFC 9562 v5, the same device as `item_prices` and
-- `product_units`), so every till computes the same id for the same pair and no
-- two tills ever write the same row.
--
-- That single-owner property is what makes the merge trivial: there is nothing
-- to merge. It is the same argument that makes `idx_cash_sessions_one_open`
-- safe and that `price_lists.is_default` did not have -- a constraint or a value
-- is only sound across tills when the rows under it have one writer.
--
-- The screen then asks the question it always meant: the *latest* sign-in across
-- the shop, and the *total* of the wrong passwords. Both are better answers than
-- the column gave, not merely quieter ones.
--
-- ── No backfill, deliberately ─────────────────────────────────────────────
--
-- A row here needs this till's device id, and the database does not have one:
-- `device.json` holds it and the backup deliberately does not carry it. A
-- migration cannot know it.
--
-- So `users.last_login_at` and `users.failed_logins` stay exactly as they are
-- and are never written again. They become the shop's shared baseline -- what
-- was known on the day of this migration -- and `listStaff` reads the later of
-- that and the session rows, and the sum of that and the session rows. Every
-- till already agrees on the baseline, because it replicated; so it is counted
-- once, which is right. Zeroing them instead would have shown "never signed in"
-- against every name on the morning of the upgrade.
--
-- They are vestigial in the same way as `price_lists.is_default`: dropping them
-- means rebuilding a table that four others point at, for two columns that cost
-- nothing where they are.
--
-- ── No unique index on (user_id, device_id) ───────────────────────────────
--
-- It would be a second way to say what the primary key already says, since the
-- id *is* that pair, and every constraint on a replicated table is one more
-- thing a peer's row can be quarantined by. 038's list of twenty-two is long
-- enough.

CREATE TABLE user_sessions (
  id           TEXT PRIMARY KEY,

  user_id      TEXT NOT NULL REFERENCES users(id),
  -- The till, not a peer: this is the machine that wrote the row, and it has no
  -- `sync_peers` entry of its own to point at.
  device_id    TEXT NOT NULL,

  last_login_at  TEXT,
  failed_logins  INTEGER NOT NULL DEFAULT 0,

  rev          INTEGER NOT NULL DEFAULT 1,
  origin_id    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

CREATE TRIGGER bump_rev_user_sessions AFTER UPDATE ON user_sessions FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE user_sessions SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER feed_user_sessions_ins AFTER INSERT ON user_sessions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'user_sessions' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('user_sessions', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_user_sessions_upd AFTER UPDATE ON user_sessions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'user_sessions' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('user_sessions', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_user_sessions_del AFTER DELETE ON user_sessions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'user_sessions' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('user_sessions', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;
