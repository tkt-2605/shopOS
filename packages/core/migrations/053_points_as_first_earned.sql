-- What a loyalty entry was worth when it was earned, kept.
--
-- A return takes points back off the entry its bill earned (`clawBackPoints`),
-- and cancelling the return puts them back (`regrantPoints`) -- both by
-- editing `points` in place. After 051 an edit merges by revision, so two
-- tills each taking a partial return of one bill while apart both edit the
-- entry, one copy wins, and the other return's clawback is lost: the customer
-- keeps points the shop took back.
--
-- The returns themselves say how much was taken (`sales_returns.points_removed`)
-- and they merge whole. What was missing was the figure they were taken from.
-- With `earned` kept, `reconcileLoyalty` can work out `points` as earned less
-- what submitted returns removed, however the edits interleaved.
--
-- Backfilled as the current points plus what submitted returns of the bill
-- removed, for entries still standing. An entry already cancelled keeps its
-- current points as its earned figure: it counts for nothing either way, and
-- a clawback that cancelled it left `points` where it was, so adding the
-- removals back would overstate it.
--
-- Nullable, so a till below 053 relaying an entry leaves this NULL rather
-- than a wrong figure, and the reconcile then leaves `points` alone. Additive.

ALTER TABLE loyalty_entries ADD COLUMN earned INTEGER CHECK (earned IS NULL OR earned > 0);

UPDATE loyalty_entries
   SET earned = points + CASE WHEN cancelled_at IS NOT NULL THEN 0 ELSE COALESCE((
         SELECT SUM(r.points_removed) FROM sales_returns r
          WHERE r.bill_id = loyalty_entries.bill_id AND r.docstatus = 1), 0) END;
