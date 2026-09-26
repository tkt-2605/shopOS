-- A loyalty entry is edited, so it needs a revision.
--
-- `loyalty_entries` was set up as a ledger in the `stock_ledger` sense --
-- rows written once and merged by union, "append-only, cannot conflict"
-- (021) -- and so it was given no `rev` and no `updated_at`. The services
-- never treated it that way. Redeeming raises `consumed`, a return lowers it,
-- cancelling a bill stamps `cancelled_at`, and a return takes earned `points`
-- off the entry itself.
--
-- With no revision, the merge rule had nothing to go on but its last
-- tiebreak, the higher device id. So an entry edited on one till and never
-- touched on the other was kept stale by whichever till had the higher id,
-- every time: the redemption arrived inside its bill, the entry did not move,
-- and the two tills disagreed for good about a customer's balance -- who
-- could then spend the same points again at the till that had not heard.
--
-- A revision makes the one-sided edit win, as it does everywhere else.
-- Two tills editing the same entry concurrently is the part a revision
-- cannot fix -- one of two increments would be lost -- so after every merge
-- `reconcileLoyalty` recomputes `consumed` from `loyalty_redemptions`, which
-- travel with their bill, and `cancelled_at` from the bill's own status.
-- `consumed` is a cache of the redemptions from here on, and has a detector.
--
-- Additive. The trigger fires only when the service did not set `rev` itself,
-- and stands down while a merge is applying, exactly as 039's do.

ALTER TABLE loyalty_entries ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE loyalty_entries ADD COLUMN updated_at TEXT;

CREATE TRIGGER bump_rev_loyalty_entries AFTER UPDATE ON loyalty_entries FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE loyalty_entries
     SET rev = OLD.rev + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE rowid = NEW.rowid;
END;
