-- A bill nobody has rung up yet stays on the till that is typing it.
--
-- ── What travels today, and should not ────────────────────────────────────
--
-- A draft bill is `docstatus 0`: a cashier part-way through a sale, with lines
-- appearing and disappearing as items are scanned and taken off again. Every
-- one of those keystrokes crosses to the other counters.
--
-- It is worse than wasteful. `saveDraft` rewrites every line on every save, and
-- the line triggers from 022 raise `bills.rev` once per line — so a five-item
-- draft saved ten times is fifty revisions and ten feed entries on a row nobody
-- else can see. They cannot see it because `listOpenDrafts` filters by
-- `register_id` and a counter belongs to one till, so every draft that arrives
-- is invisible on arrival and always was.
--
-- What that costs is not one till's bandwidth, it is everybody's: a draft being
-- typed on the front counter is a round of traffic on every edge in the shop,
-- repeatedly, for a row that will either become a bill in a minute or be thrown
-- away. Add a till and it costs more. It is also the last hard delete on
-- `bills` — discarding a draft removes the row — and 041 sets out why a hard
-- delete on a replicated table is the one shape that will not settle.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
-- The feed triggers on `bills` and on its four line tables gain a predicate:
-- nothing about a bill enters the feed while it is a draft. Submitting it is an
-- UPDATE to `docstatus`, which fires `feed_bills_upd` with the new value, so
-- the bill enters the feed at the moment it becomes a bill — whole, with every
-- line, because `collectChanges` reads the lines when it sends rather than when
-- it marks. Nothing is lost and nothing arrives early.
--
-- The `rev` bump on the line triggers goes quiet for a draft too, which is the
-- point rather than a side effect: a draft that climbs fifty revisions while
-- another till holds it at one wins every tiebreak it is ever in, on the
-- strength of having been typed slowly.
--
-- A line trigger asks the bill what it is. A line deleted after its bill has
-- already gone finds no row, `NULL <> 0` is NULL, and the trigger stands down —
-- which is the right answer: there is no bill left to tell anybody about.
--
-- ── What this does not do ─────────────────────────────────────────────────
--
-- Only `bills`. `documents` has drafts too — a quotation being written up — and
-- they are a different thing: a quotation is worked on over days, printed,
-- and handed to somebody, so a second till having it is the point. The `sales`
-- side is the one where a draft is half a keystroke.
--
-- A draft that already replicated stays where it landed, holding whatever it
-- held. It is invisible there, as it always was, and it comes back into the
-- feed the moment it is submitted.
--
-- Additive: no column changes and no row changes, so a till on either side of
-- this still syncs with one on the other. The older till will go on sending its
-- drafts for as long as it is older, and the newer one will go on ignoring them
-- on the screen exactly as it does now.

DROP TRIGGER feed_bills_ins;
CREATE TRIGGER feed_bills_ins AFTER INSERT ON bills FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND NEW.docstatus <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

DROP TRIGGER feed_bills_upd;
CREATE TRIGGER feed_bills_upd AFTER UPDATE ON bills FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND NEW.docstatus <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

DROP TRIGGER feed_bills_del;
CREATE TRIGGER feed_bills_del AFTER DELETE ON bills FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND OLD.docstatus <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('bills', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

DROP TRIGGER feed_bill_items_ins;
CREATE TRIGGER feed_bill_items_ins AFTER INSERT ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_items_upd;
CREATE TRIGGER feed_bill_items_upd AFTER UPDATE ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_items_del;
CREATE TRIGGER feed_bill_items_del AFTER DELETE ON bill_items FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = OLD.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;

DROP TRIGGER feed_bill_payments_ins;
CREATE TRIGGER feed_bill_payments_ins AFTER INSERT ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_payments_upd;
CREATE TRIGGER feed_bill_payments_upd AFTER UPDATE ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_payments_del;
CREATE TRIGGER feed_bill_payments_del AFTER DELETE ON bill_payments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = OLD.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;

DROP TRIGGER feed_bill_fulfilments_ins;
CREATE TRIGGER feed_bill_fulfilments_ins AFTER INSERT ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_fulfilments_upd;
CREATE TRIGGER feed_bill_fulfilments_upd AFTER UPDATE ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_bill_fulfilments_del;
CREATE TRIGGER feed_bill_fulfilments_del AFTER DELETE ON bill_fulfilments FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = OLD.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;

DROP TRIGGER feed_loyalty_redemptions_ins;
CREATE TRIGGER feed_loyalty_redemptions_ins AFTER INSERT ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_loyalty_redemptions_upd;
CREATE TRIGGER feed_loyalty_redemptions_upd AFTER UPDATE ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = NEW.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = NEW.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', NEW.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = NEW.bill_id;
END;

DROP TRIGGER feed_loyalty_redemptions_del;
CREATE TRIGGER feed_loyalty_redemptions_del AFTER DELETE ON loyalty_redemptions FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
 AND (SELECT docstatus FROM bills WHERE id = OLD.bill_id) <> 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'bills' AND row_id = OLD.bill_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('bills', OLD.bill_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE bills SET rev = rev + 1 WHERE id = OLD.bill_id;
END;
