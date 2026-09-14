-- What a person is owed about two tills, once nobody is pressing the button.
--
-- Up to here a sync happened because somebody asked for it and stood watching
-- the answer. A catch-up that runs on its own has nobody watching, and the
-- failures that matter are exactly the ones nothing interrupts: the other till
-- switched off at four o'clock and nobody notices until Friday; two people
-- changed the same price and one of those changes is gone.
--
-- Phase 3 of docs/multi-device.md, which says it plainly: a sync that is silent
-- when it is working and silent when it is not is a sync nobody trusts.
--
-- ── Two things, because they fail differently ──────────────────────────────
--
-- `sync_conflicts` is where somebody's edit was dropped. It is a record, not a
-- queue: nothing retries it, nothing repairs it, and the only thing that can be
-- done about it is for a person to look and decide whether it mattered. Written
-- inside the same transaction that applies the batch, so a merge that rolls back
-- does not leave a complaint about a change it did not make.
--
-- `last_error` and `last_tried_at` on `sync_peers` are where a till could not be
-- reached at all. That is one fact per peer rather than a history, because the
-- useful question is "is it working now, and since when has it not been" — a
-- thousand rows saying the same till was off all weekend answer it worse than
-- one row saying so.
--
-- Neither replicates. Both are this machine's view of the others, and the other
-- till has its own.

CREATE TABLE sync_conflicts (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  -- Which till the losing or winning change came from.
  peer_device   TEXT,
  table_name    TEXT NOT NULL,
  row_id        TEXT NOT NULL,
  -- 'mine' when this till's change was kept, 'theirs' when it was overwritten.
  winner        TEXT NOT NULL CHECK (winner IN ('mine', 'theirs')),
  -- The sentence the merge rule produced, in words a shopkeeper can read.
  explain       TEXT NOT NULL,
  -- Cleared when somebody has looked. Not deleted: the history of what the two
  -- tills disagreed about is worth keeping even after it has been read.
  acknowledged  INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
) STRICT;

CREATE INDEX idx_sync_conflicts_at ON sync_conflicts(acknowledged, at);

ALTER TABLE sync_peers ADD COLUMN last_error TEXT;
ALTER TABLE sync_peers ADD COLUMN last_tried_at TEXT;
