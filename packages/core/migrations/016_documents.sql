-- Quotations, sales orders and purchase orders.
--
-- One table for three documents, because they differ in who they are addressed
-- to and what they turn into — not in what they are. All three are a party, a
-- list of lines, a set of totals and a promise; splitting them into three tables
-- would triple the queries and the conversion code without making any of them
-- clearer.
--
-- The column names and shapes deliberately follow `bills` and `bill_items`, so
-- the two can be read side by side and converting one into the other is a
-- mapping rather than a translation.
--
-- Nothing here touches stock. A submitted order moves no ledger row: that is
-- what `affectsLedgers` in integrity/docstatus.ts decides, and these answer no.
-- Reserving stock against an order would touch every stock query in the product
-- and is a separate decision, deliberately not taken here.
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  doc_no          TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('quotation', 'sales_order', 'purchase_order')),
  docstatus       INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0, 1, 2)),
  register_id     TEXT NOT NULL REFERENCES registers(id),

  -- A sales document names a customer; a purchase order names a supplier. One
  -- of the two, never both, which the CHECK at the end of the table enforces.
  customer_id     TEXT REFERENCES customers(id),
  customer_name   TEXT,
  supplier_id     TEXT REFERENCES suppliers(id),
  supplier_name   TEXT,

  posting_date    TEXT NOT NULL,
  -- A quotation that never expires is a price the shop is held to for ever.
  valid_until     TEXT,

  subtotal        INTEGER NOT NULL DEFAULT 0,
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  taxable_total   INTEGER NOT NULL DEFAULT 0,
  tax_total       INTEGER NOT NULL DEFAULT 0,
  round_off       INTEGER NOT NULL DEFAULT 0,
  grand_total     INTEGER NOT NULL DEFAULT 0,

  place_of_supply TEXT,
  notes           TEXT,
  terms           TEXT,

  -- What this came from, when it was made by converting something else. The
  -- chain a quotation walks is quotation -> sales order -> bill.
  converted_from  TEXT REFERENCES documents(id),

  created_by      TEXT NOT NULL REFERENCES users(id),
  cancelled_by    TEXT REFERENCES users(id),
  cancelled_at    TEXT,
  cancel_reason   TEXT,
  rev             INTEGER NOT NULL DEFAULT 1,
  origin_id       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (
    (kind = 'purchase_order' AND supplier_id IS NOT NULL AND customer_id IS NULL)
    OR (kind <> 'purchase_order' AND supplier_id IS NULL)
  )
) STRICT;

CREATE TABLE document_items (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  product_id      TEXT NOT NULL REFERENCES products(id),
  -- Snapshot, for the same reason bill_items keeps one: renaming a product must
  -- never rewrite what a quotation the customer is holding said.
  product_name    TEXT NOT NULL,
  hsn_code        TEXT,
  sale_unit       TEXT NOT NULL,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  base_qty        INTEGER NOT NULL CHECK (base_qty > 0),
  rate            INTEGER NOT NULL CHECK (rate >= 0),
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_total      INTEGER NOT NULL CHECK (line_total >= 0),
  taxable_value   INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp     INTEGER NOT NULL DEFAULT 0,
  cgst_amount     INTEGER NOT NULL DEFAULT 0,
  sgst_amount     INTEGER NOT NULL DEFAULT 0,
  igst_amount     INTEGER NOT NULL DEFAULT 0,

  -- How much of this line has already been billed or received. What makes
  -- "50 ordered, 20 billed, 30 left" a fact rather than an inference, and what a
  -- half-delivered order needs in order to be finished later.
  fulfilled_qty   INTEGER NOT NULL DEFAULT 0 CHECK (fulfilled_qty >= 0),

  UNIQUE (document_id, idx)
) STRICT;

-- The lists these tables are read through: a party's own documents, and the
-- open ones of a kind on a date.
CREATE INDEX idx_documents_kind_date ON documents(kind, posting_date);
CREATE INDEX idx_documents_customer ON documents(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_documents_supplier ON documents(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_documents_converted ON documents(converted_from) WHERE converted_from IS NOT NULL;
CREATE INDEX idx_document_items_doc ON document_items(document_id);
