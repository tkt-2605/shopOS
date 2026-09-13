-- 014: Document format definitions for thermal and PDF output
-- Allows shops to customize which blocks appear on receipts and invoices.

CREATE TABLE doc_formats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  paper TEXT NOT NULL CHECK (paper IN ('thermal_58', 'thermal_80', 'a4', 'a5')),
  kinds TEXT NOT NULL,
  blocks TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO doc_formats (id, name, paper, kinds, blocks, created_at, updated_at)
VALUES
  (
    'thermal_default',
    'Standard Receipt',
    'thermal_58',
    '["bill","quotation","sales_order"]',
    '[{"kind":"logo","on":true},{"kind":"shop","on":true},{"kind":"title","on":true,"opts":{"label":"BILL"}},{"kind":"meta","on":true},{"kind":"party","on":true},{"kind":"items","on":true,"opts":{"columns":"qty,rate,total"}},{"kind":"totals","on":true},{"kind":"tax_summary","on":true},{"kind":"payments","on":true},{"kind":"amount_in_words","on":true},{"kind":"terms","on":true},{"kind":"space","on":true,"opts":{"lines":2}}]',
    datetime('now'),
    datetime('now')
  ),
  (
    'a4_default',
    'A4 Invoice',
    'a4',
    '["bill","quotation","sales_order"]',
    '[{"kind":"logo","on":true,"opts":{"align":"right"}},{"kind":"shop","on":true},{"kind":"title","on":true,"opts":{"label":"INVOICE"}},{"kind":"meta","on":true},{"kind":"party","on":true,"opts":{"style":"box"}},{"kind":"items","on":true,"opts":{"columns":"hsn,item,qty,rate,total,tax"}},{"kind":"tax_summary","on":true},{"kind":"totals","on":true},{"kind":"amount_in_words","on":true},{"kind":"terms","on":true},{"kind":"signature","on":true}]',
    datetime('now'),
    datetime('now')
  );
