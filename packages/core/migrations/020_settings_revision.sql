-- `settings` is edited from a screen, has to reach a second till, and carried no
-- revision at all.
--
-- It holds the shop's name, its state code, the stock policy, the rounding rule,
-- the loyalty programme and every feature switch. 019 put a trigger on twenty
-- tables and left this one out, which would have made it a special case in
-- whatever merge ships.
--
-- It is **not** the last such table, and an earlier draft of this header said it
-- was. Still without `rev`, and each for its own reason:
--
--   role_permissions, role_pages   the permission grid, edited from the Roles
--                                  screen. Same fault as this one and they want
--                                  the same fix -- owed, not done here.
--   doc_formats                    the shop's own bill layouts, same again.
--   product_stock, doc_sequences   derived, not authored. A merge has to
--                                  recompute the first and cannot take either
--                                  side of the second -- last-writer-wins on a
--                                  number series would hand two tills the same
--                                  invoice number, which is the one outcome this
--                                  whole seam exists to prevent. They want a
--                                  different rule, so they are deliberately out.
--
-- What it already gets right is the granularity: one row per setting, so the
-- unit of conflict is one setting rather than a blob. Two tills changing two
-- different settings do not collide at all, and two tills changing the *same*
-- setting is a genuine disagreement that a person has to lose. That is exactly
-- what row-level last-writer-wins is for, and `rev` is what it compares.
--
-- Costing nothing is what settles the timing. There is no INSERT to rewrite and
-- no call site to remember: the trigger maintains it, the same way it does for
-- the other twenty. `setSetting`'s upsert is ON CONFLICT DO UPDATE, which is an
-- UPDATE, so it bumps like any other write rather than resetting to 1.
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
