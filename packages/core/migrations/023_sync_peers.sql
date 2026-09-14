-- Who this machine has paired with, and how far each of them has read.
--
-- Two cursors per peer, and they are not the same number seen from two sides:
--
--   their_cursor  how far into *their* feed this machine has read. Sent with
--                 every request, so they know where to start.
--   my_cursor     how far into *this* machine's feed they have confirmed
--                 receiving. Only moved when they say so, never when we send:
--                 a batch that left here and never arrived must be sent again,
--                 and a cursor moved on hope is a row lost in silence.
--
-- `last_agreed_at` is the only thing here a person sees. "These two tills last
-- agreed at 4:50" is the whole of what a shopkeeper needs to know about sync
-- working, and a sync that is silent when it is working and silent when it is
-- broken is one nobody trusts.
--
-- ── Why this is a table and device.json is a file ──────────────────────────
--
-- Device identity is one value that must never be copied, so it lives outside
-- the database where no backup and no restore can carry it. A peer list is a
-- set that grows, is queried, and joins to nothing — a table is the right shape
-- for it, and copying one is harmless: a restored database on a new machine
-- holds peers it has not paired with, and the first handshake with each says so.
-- Nothing is lost and nothing is wrongly claimed, which is the test that failed
-- for `device_register_id` and passes here.
--
-- Not replicated, deliberately. Which tills this one has met is a fact about
-- this one. `NOT_REPLICATED` in replicaShape.ts carries the reason, and the
-- coverage test would fail if it did not.

CREATE TABLE sync_peers (
  device_id      TEXT PRIMARY KEY,
  label          TEXT,
  their_cursor   INTEGER NOT NULL DEFAULT 0,
  my_cursor      INTEGER NOT NULL DEFAULT 0,
  last_agreed_at TEXT,
  created_at     TEXT NOT NULL
) STRICT;
