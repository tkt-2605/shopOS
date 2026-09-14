-- `settings` was the one mutable table with no revision on it.
--
-- It holds the shop's name, its state code, the stock policy, the rounding rule,
-- the loyalty programme and every feature switch — all things that have to reach
-- a second till — and it was the only such table carrying neither `rev` nor
-- `origin_id`. 019 put a trigger on twenty tables and left this one out, which
-- would have made it the single special case in whatever merge ships.
--
-- What it already gets right is the granularity: one row per setting, so the
-- unit of conflict is one setting rather than a blob. Two tills changing two
-- different settings do not collide at all, and two tills changing the *same*
-- setting is a genuine disagreement that a person has to lose. That is exactly
-- what row-level last-writer-wins is for, and `rev` is what it compares.
--
-- Costing nothing is what settles the timing. There is no INSERT to rewrite and
-- no call site to remember: the trigger maintains it, the same way it does for
-- the other twenty.
--
-- Not every row here belongs to the shop, and the ones that do not are being
-- moved out rather than given a revision — `device_register_id` went to
-- device.json in the change before this one, and `backup_hook` goes with it,
-- because a command run after a backup is a command run on *this machine* and
-- two tills would both fire it.

ALTER TABLE settings ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN origin_id TEXT;

CREATE TRIGGER bump_rev_settings AFTER UPDATE ON settings FOR EACH ROW
WHEN NEW.rev = OLD.rev
BEGIN
  UPDATE settings SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;
