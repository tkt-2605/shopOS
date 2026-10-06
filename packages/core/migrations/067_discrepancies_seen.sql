-- Which discrepancies a person on this till has seen.
--
-- `findDiscrepancies` reads the shop and lists what does not add up: an item
-- refunded on two counters while they were apart, an order billed twice, stock
-- below zero, a customer past their limit, books that do not balance. It
-- writes nothing and keeps nothing, so a till would tell somebody about the
-- same double refund on every start for ever. This is what it has been told
-- about: a key per discrepancy, which changes when the facts do -- a third
-- refund of the same line is a new key, and is told again.
--
-- Stays on this till, like `sync_conflicts.acknowledged`: having been seen at
-- one counter is not having been seen at the other.
--
-- Additive: a table that never travels.

CREATE TABLE discrepancies_seen (
  key      TEXT PRIMARY KEY,
  seen_at  TEXT NOT NULL,
  seen_by  TEXT
) STRICT;
