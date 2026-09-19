-- Which price list a walk-in is charged on stops being an index.
--
-- ── What was wrong ────────────────────────────────────────────────────────
--
-- `idx_price_lists_one_default` is `UNIQUE (is_default) WHERE is_default = 1`:
-- mutual exclusion expressed as an index. On one till it is exactly right and it
-- has done its job since 001 — a shop with two defaults has no answer for a
-- customer who is not on a list.
--
-- Two tills cannot satisfy it. The rule is about the shop, the index is about a
-- file, and each till enforces it against its own rows and nothing else. Two
-- counters offline each make a different list the default, quite legitimately;
-- both rows arrive at the third till, and the second one to land raises
-- `UNIQUE constraint failed: price_lists.is_default` — a stall until 038, a
-- quarantined row after it, and either way a shop whose price lists have stopped
-- replicating over a checkbox.
--
-- There is a second cost, paid every day rather than once. Marking a list the
-- default runs `UPDATE price_lists SET is_default = 0` across every row, so
-- every list in the shop gains a revision and enters the feed — to record one
-- fact about one of them.
--
-- ── What it becomes ───────────────────────────────────────────────────────
--
-- A setting holding the id. `default_price_list_id` is one value in one row, and
-- two tills that disagree about it disagree the way they disagree about a shop
-- name: the later edit wins, both tills end up on the same list, and nothing is
-- refused on the way. Exactly one answer is representable, which is what the
-- index was for, and it is representable without a constraint that only one
-- machine can see.
--
-- `is_default` stays on the table and stops being read. Dropping a column means
-- rebuilding a table that `item_prices` and `customers` both point at, and it is
-- inert where it is — nothing writes it from here on and nothing consults it.
-- The next migration that rebuilds `price_lists` for a reason of its own should
-- take it out.
--
-- The value is seeded from whatever the shop currently has, inside the
-- `applying` bracket. Every till performs this identically over the same rows, so
-- feeding it would manufacture a conflict on a row nobody touched — 033 carries
-- the argument, and `settings` is already named in `WRITTEN_BY_A_MIGRATION`.
--
-- Additive, with a caveat worth stating rather than discovering: a till that has
-- not run this yet still writes `is_default` and still holds the index, so a list
-- made the default on a newer till will not become the default there until it
-- upgrades. It is a checkbox out of step for the length of a rollout, and the
-- alternative — classifying this breaking — is every till in the shop refusing to
-- sync until the last one is updated.

DROP INDEX idx_price_lists_one_default;

UPDATE sync_state SET applying = 1 WHERE id = 1;

INSERT INTO settings (key, value, updated_at)
SELECT 'default_price_list_id', id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM price_lists
 WHERE is_default = 1
   AND deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'default_price_list_id')
 LIMIT 1;

UPDATE sync_state SET applying = 0 WHERE id = 1;
