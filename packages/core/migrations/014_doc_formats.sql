-- The shop's own bill layouts.
--
-- A table rather than a settings value, because this is a list — several
-- layouts across two paper sizes, looked up by which document is being printed
-- and on what. A list inside a settings blob is a list nothing can query, and
-- the print path asks that question on every sale.
--
-- `paper` allows only what the renderer can actually produce. A4 widens this
-- CHECK in its own migration, when `pdf.rs` has grown the sections to print it;
-- a row here that nothing can render would be one more setting written by a
-- screen and read by nobody, which is the fault this whole round exists to fix.
CREATE TABLE doc_formats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  paper TEXT NOT NULL CHECK (paper IN ('thermal_58', 'thermal_80')),
  -- JSON arrays. Read only by services/formats.ts, which drops a row it cannot
  -- parse rather than letting a bad one reach the printer.
  kinds TEXT NOT NULL,
  blocks TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- The format the product has always printed, written down for the first time.
--
-- Every switch here matches what `buildReceipt` did before formats existed: the
-- taxes sit inside the totals block, the customer shares the bill-number line,
-- and the blocks that would print a second copy of either are off. `logo` and
-- `amount_in_words` are off because neither has a renderer yet — a switch that
-- is on and does nothing teaches a shopkeeper that the switches do not matter.
INSERT INTO doc_formats (id, name, paper, kinds, blocks, created_at, updated_at)
VALUES (
  'standard_receipt',
  'Standard receipt',
  'thermal_80',
  '["bill"]',
  '[{"kind":"logo","on":false},{"kind":"shop","on":true},{"kind":"title","on":false,"opts":{"label":"TAX INVOICE"}},{"kind":"meta","on":true},{"kind":"party","on":false},{"kind":"items","on":true},{"kind":"totals","on":true},{"kind":"tax_summary","on":false},{"kind":"payments","on":true},{"kind":"loyalty","on":true},{"kind":"amount_in_words","on":false},{"kind":"terms","on":true},{"kind":"signature","on":false}]',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
