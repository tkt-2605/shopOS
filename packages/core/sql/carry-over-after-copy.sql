-- A joining till takes a copy of the shop and keeps everything that is its own.
--
-- Run on the copy once it is in place as this till's database, with the
-- database it replaced attached as `prev`, in one transaction, before the swap
-- is committed. Idempotent: every table is replaced whole and the audit rows
-- are added only where missing, so a power cut that makes the next start run
-- it again gives the same result.
--
-- What is carried is exactly what `prepare-copy.sql` emptied: the tables that
-- are true of a machine rather than of the shop. Pairing secrets and cursors
-- (sync_peers), what this till still has to send (change_feed), its own
-- invoice series (doc_sequences), and what it has set aside or been told.
-- `main_device` and `main_epoch` come across too: this till joined the main
-- before it asked for the copy, and the copy says nothing about who the main is.
--
-- The cursor on the main is set by the caller, to the head the copy recorded:
-- everything the main's feed had issued is in the copy, so the first round
-- asks only for what was written after it.

DELETE FROM main.sync_peers;
INSERT INTO main.sync_peers SELECT * FROM prev.sync_peers;
DELETE FROM main.change_feed;
INSERT INTO main.change_feed SELECT * FROM prev.change_feed;
DELETE FROM main.sync_conflicts;
INSERT INTO main.sync_conflicts SELECT * FROM prev.sync_conflicts;
DELETE FROM main.sync_quarantine;
INSERT INTO main.sync_quarantine SELECT * FROM prev.sync_quarantine;
DELETE FROM main.discrepancies_seen;
INSERT INTO main.discrepancies_seen SELECT * FROM prev.discrepancies_seen;
-- A joining till does not send bills, so it starts with none noted.
DELETE FROM main.bill_emails;
DELETE FROM main.doc_sequences;
INSERT INTO main.doc_sequences SELECT * FROM prev.doc_sequences;
INSERT INTO main.audit_log
  SELECT * FROM prev.audit_log WHERE id NOT IN (SELECT id FROM main.audit_log);
UPDATE main.sync_state
   SET applying = 0,
       pruned_through = (SELECT pruned_through FROM prev.sync_state WHERE id = 1),
       main_device = (SELECT main_device FROM prev.sync_state WHERE id = 1),
       main_epoch = (SELECT main_epoch FROM prev.sync_state WHERE id = 1)
 WHERE id = 1;
