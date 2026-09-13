-- A4 and A5, now that something can render them.
--
-- Migration 014 allowed only the two roll sizes, deliberately: a format the
-- code could not print would have been one more setting written by a screen and
-- read by nobody. `domain/invoiceHtml.ts` renders a sheet, so the constraint
-- widens and a sheet format can be stored.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt. STRICT and the
-- column order are carried over unchanged.
CREATE TABLE doc_formats_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  paper TEXT NOT NULL CHECK (paper IN ('thermal_58', 'thermal_80', 'a4', 'a5')),
  kinds TEXT NOT NULL,
  blocks TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO doc_formats_new (id, name, paper, kinds, blocks, created_at, updated_at)
SELECT id, name, paper, kinds, blocks, created_at, updated_at FROM doc_formats;

DROP TABLE doc_formats;
ALTER TABLE doc_formats_new RENAME TO doc_formats;

-- A sheet invoice, which is a different document from a till receipt even
-- though it is built from the same blocks.
--
-- The customer goes in a block of their own here rather than sharing the
-- bill-number line: a sheet has the room, and an invoice a business files needs
-- the party it was billed to stated plainly. `signature` and `tax_summary` earn
-- their place for the same reason. `loyalty` does not — points belong on the
-- slip handed across the counter, not on the copy that goes into a ledger.
INSERT INTO doc_formats (id, name, paper, kinds, blocks, created_at, updated_at)
VALUES (
  'a4_invoice',
  'A4 invoice',
  'a4',
  '["bill"]',
  '[{"kind":"logo","on":false},{"kind":"shop","on":true},{"kind":"title","on":true,"opts":{"label":"Tax Invoice"}},{"kind":"meta","on":true},{"kind":"party","on":true},{"kind":"items","on":true},{"kind":"tax_summary","on":true},{"kind":"totals","on":true},{"kind":"payments","on":true},{"kind":"loyalty","on":false},{"kind":"amount_in_words","on":false},{"kind":"terms","on":true},{"kind":"signature","on":true}]',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
