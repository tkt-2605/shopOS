-- Photographs against a document.
--
-- The handwritten list a customer brings to the counter, a signed delivery, a
-- UPI screenshot, the distributor's invoice against a stock entry. A shop keeps
-- these on paper today and loses them; a bill that can show its evidence settles
-- an argument three months later.
--
-- Files on disk, rows here. Not blobs: the Tauri driver's bind() rejects byte
-- arrays outright, and a blob column would put every photograph inside the
-- database and so inside every VACUUM INTO.

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  entity       TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  -- Relative to the attachments root, and content-addressed: the same
  -- photograph attached to two documents is one file on disk, which is also
  -- what lets a backup carry each one once.
  stored_path  TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  caption      TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  rev          INTEGER NOT NULL DEFAULT 1,
  origin_id    TEXT,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
) STRICT;

-- The only read that happens at the counter: everything on this document.
CREATE INDEX idx_attachments_entity ON attachments (entity, entity_id) WHERE deleted_at IS NULL;

-- Asked twice on every delete — is any other row still pointing at this file —
-- and once per file when a backup collects what it has to carry.
CREATE INDEX idx_attachments_sha ON attachments (sha256) WHERE deleted_at IS NULL;
