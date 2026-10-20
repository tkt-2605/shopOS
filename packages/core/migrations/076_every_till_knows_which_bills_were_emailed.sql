-- Every till knows which bills were emailed.
--
-- 073 kept `bill_emails` on the main: the main was the only till that sends,
-- and its note of what it had queued was all that stopped a bill going twice.
-- That holds while there is one main. It does not when there are two -- two
-- people pressing "Make this the main till" on machines that cannot see each
-- other -- or when the main changes: the new main had none of the old main's
-- notes, and a bill both had would be mailed again by whichever learned of it
-- second. So the note travels now, as a record like any other: every till
-- holds every note, and a bill some till has emailed is not emailed by another.
--
-- Two mains that cannot reach each other can still each send one bill they
-- both hold; nothing can stop that while they cannot talk. What this stops is
-- the second send after they meet, and every send after a change of main.
--
-- `rev` and `origin_id` as every edited record carries them: a note is written
-- again when a failed bill is tried and fails again, and taken away (a delete,
-- with its revision, 040) when somebody presses Try again.
--
-- The notes already here are fed, so the main's record of what it has sent so
-- far reaches the other tills at the next sync, before any of them is made the
-- main.
--
-- Additive. A till below 076 has no `bill_emails` in its replicated list and
-- skips these records (`ignoredTables`). A till at 073 to 075 that is the main
-- goes on noting only its own sends, as it does today.

ALTER TABLE bill_emails ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bill_emails ADD COLUMN origin_id TEXT;

CREATE TRIGGER bump_rev_bill_emails AFTER UPDATE ON bill_emails FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE bill_emails SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER feed_bill_emails_ins AFTER INSERT ON bill_emails FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bill_emails' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bill_emails', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_emails_upd AFTER UPDATE ON bill_emails FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bill_emails' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bill_emails', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_bill_emails_del AFTER DELETE ON bill_emails FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bill_emails' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('bill_emails', OLD.bill_id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

INSERT INTO change_feed (table_name, row_id, op, at)
SELECT 'bill_emails', bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM bill_emails;
