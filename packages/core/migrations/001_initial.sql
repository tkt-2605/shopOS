-- ShopOS initial schema.
--
-- Conventions, applied without exception:
--   * ids are TEXT UUIDv7 — two offline registers must never mint the same key
--   * money is INTEGER paise; quantity is INTEGER scaled 10^4; tax is INTEGER basis points
--   * timestamps are TEXT ISO-8601 UTC
--   * documents carry docstatus 0 draft / 1 submitted / 2 cancelled and are never
--     updated after submit — correction is cancel + amend
--   * foreign keys RESTRICT; anything a document references is soft-deleted, never removed
--   * rev / origin_id / deleted_at exist on mutable tables for replication and are
--     written but not read until sync ships

PRAGMA foreign_keys = ON;

-- ─────────────────────────────  configuration  ─────────────────────────────

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

-- ─────────────────────────────  access control  ────────────────────────────

CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  rev         INTEGER NOT NULL DEFAULT 1,
  origin_id   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;

CREATE TABLE role_permissions (
  id          TEXT PRIMARY KEY,
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  resource    TEXT NOT NULL,
  can_read    INTEGER NOT NULL DEFAULT 0 CHECK (can_read   IN (0, 1)),
  can_create  INTEGER NOT NULL DEFAULT 0 CHECK (can_create IN (0, 1)),
  can_write   INTEGER NOT NULL DEFAULT 0 CHECK (can_write  IN (0, 1)),
  can_delete  INTEGER NOT NULL DEFAULT 0 CHECK (can_delete IN (0, 1)),
  can_submit  INTEGER NOT NULL DEFAULT 0 CHECK (can_submit IN (0, 1)),
  can_cancel  INTEGER NOT NULL DEFAULT 0 CHECK (can_cancel IN (0, 1)),
  can_amend   INTEGER NOT NULL DEFAULT 0 CHECK (can_amend  IN (0, 1)),
  UNIQUE (role_id, resource)
) STRICT;

-- Page visibility is stored beside permissions so the sidebar and the route guard
-- read one source; a page the owner hides is also a route the user cannot reach.
CREATE TABLE role_pages (
  role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  page_key  TEXT NOT NULL,
  visible   INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0, 1)),
  PRIMARY KEY (role_id, page_key)
) STRICT;

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  full_name      TEXT,
  role_id        TEXT NOT NULL REFERENCES roles(id),
  password_hash  TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT,
  rev            INTEGER NOT NULL DEFAULT 1,
  origin_id      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
) STRICT;

CREATE INDEX idx_users_role ON users(role_id);

-- ─────────────────────────────  product masters  ───────────────────────────

CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES categories(id),
  rev        INTEGER NOT NULL DEFAULT 1,
  origin_id  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE products (
  id               TEXT PRIMARY KEY,
  code             TEXT UNIQUE,
  name             TEXT NOT NULL,
  brand            TEXT,
  category_id      TEXT REFERENCES categories(id),
  base_unit        TEXT NOT NULL DEFAULT 'piece',
  barcode          TEXT,
  hsn_code         TEXT,
  tax_rate_bp      INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0),
  base_rate        INTEGER NOT NULL DEFAULT 0 CHECK (base_rate >= 0),
  mrp              INTEGER CHECK (mrp IS NULL OR mrp >= 0),
  is_stock_tracked INTEGER NOT NULL DEFAULT 1 CHECK (is_stock_tracked IN (0, 1)),
  discount_blocked INTEGER NOT NULL DEFAULT 0 CHECK (discount_blocked IN (0, 1)),
  return_blocked   INTEGER NOT NULL DEFAULT 0 CHECK (return_blocked   IN (0, 1)),
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  image_path       TEXT,
  rev              INTEGER NOT NULL DEFAULT 1,
  origin_id        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
) STRICT;

CREATE INDEX idx_products_barcode  ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_name     ON products(name);
CREATE INDEX idx_products_active   ON products(is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_category ON products(category_id);

CREATE TABLE product_units (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products(id),
  sale_unit       TEXT NOT NULL,
  base_units      INTEGER NOT NULL CHECK (base_units > 0),
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  rev             INTEGER NOT NULL DEFAULT 1,
  origin_id       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (product_id, sale_unit)
) STRICT;

-- ─────────────────────────────  pricing  ───────────────────────────────────

CREATE TABLE price_lists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active  IN (0, 1)),
  rev        INTEGER NOT NULL DEFAULT 1,
  origin_id  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX idx_price_lists_one_default ON price_lists(is_default) WHERE is_default = 1;

-- Quantity tiers live here rather than on the product, so a wholesale list can
-- have different break points from retail for the same item.
CREATE TABLE item_prices (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  price_list_id TEXT NOT NULL REFERENCES price_lists(id),
  sale_unit     TEXT NOT NULL,
  min_qty       INTEGER NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  rate          INTEGER NOT NULL CHECK (rate >= 0),
  valid_from    TEXT,
  valid_to      TEXT,
  rev           INTEGER NOT NULL DEFAULT 1,
  origin_id     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  UNIQUE (product_id, price_list_id, sale_unit, min_qty)
) STRICT;

CREATE INDEX idx_item_prices_lookup ON item_prices(product_id, price_list_id, sale_unit);

-- ─────────────────────────────  parties  ───────────────────────────────────

CREATE TABLE customers (
  id                 TEXT PRIMARY KEY,
  code               TEXT UNIQUE,
  name               TEXT NOT NULL,
  phone              TEXT,
  email              TEXT,
  gstin              TEXT,
  address            TEXT,
  state_code         TEXT,
  price_list_id      TEXT REFERENCES price_lists(id),
  credit_limit       INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_enforcement TEXT NOT NULL DEFAULT 'hard' CHECK (credit_enforcement IN ('none', 'soft', 'hard')),
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  rev                INTEGER NOT NULL DEFAULT 1,
  origin_id          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
) STRICT;

CREATE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_customers_name  ON customers(name);

CREATE TABLE suppliers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  gstin      TEXT,
  address    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  rev        INTEGER NOT NULL DEFAULT 1,
  origin_id  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE customer_item_prices (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  sale_unit   TEXT NOT NULL,
  rate        INTEGER NOT NULL CHECK (rate >= 0),
  valid_from  TEXT,
  valid_to    TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  origin_id   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  UNIQUE (customer_id, product_id, sale_unit)
) STRICT;

CREATE INDEX idx_customer_item_prices_lookup ON customer_item_prices(customer_id, product_id, sale_unit);

-- ─────────────────────────────  registers & cash  ──────────────────────────

CREATE TABLE registers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  prefix     TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  rev        INTEGER NOT NULL DEFAULT 1,
  origin_id  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE cash_sessions (
  id             TEXT PRIMARY KEY,
  register_id    TEXT NOT NULL REFERENCES registers(id),
  docstatus      INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0, 1, 2)),
  opened_by      TEXT NOT NULL REFERENCES users(id),
  opened_at      TEXT NOT NULL,
  opening_cash   INTEGER NOT NULL DEFAULT 0,
  closed_by      TEXT REFERENCES users(id),
  closed_at      TEXT,
  expected_cash  INTEGER,
  actual_cash    INTEGER,
  variance       INTEGER,
  notes          TEXT,
  rev            INTEGER NOT NULL DEFAULT 1,
  origin_id      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_cash_sessions_one_open ON cash_sessions(register_id) WHERE closed_at IS NULL;

CREATE TABLE cash_movements (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES cash_sessions(id),
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL DEFAULT 'cash',
  source_type  TEXT NOT NULL,
  source_id    TEXT,
  reference    TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_cash_movements_session ON cash_movements(session_id);

-- ─────────────────────────────  sales  ─────────────────────────────────────

CREATE TABLE bills (
  id             TEXT PRIMARY KEY,
  doc_no         TEXT NOT NULL UNIQUE,
  docstatus      INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0, 1, 2)),
  amended_from   TEXT REFERENCES bills(id),
  register_id    TEXT NOT NULL REFERENCES registers(id),
  session_id     TEXT REFERENCES cash_sessions(id),
  customer_id    TEXT REFERENCES customers(id),
  customer_name  TEXT,
  posting_date   TEXT NOT NULL,
  subtotal       INTEGER NOT NULL DEFAULT 0,
  discount       INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  taxable_total  INTEGER NOT NULL DEFAULT 0,
  tax_total      INTEGER NOT NULL DEFAULT 0,
  round_off      INTEGER NOT NULL DEFAULT 0,
  grand_total    INTEGER NOT NULL DEFAULT 0,
  paid_total     INTEGER NOT NULL DEFAULT 0,
  credit_total   INTEGER NOT NULL DEFAULT 0 CHECK (credit_total >= 0),
  place_of_supply TEXT,
  idempotency_key TEXT UNIQUE,
  notes          TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id),
  cancelled_by   TEXT REFERENCES users(id),
  cancelled_at   TEXT,
  cancel_reason  TEXT,
  rev            INTEGER NOT NULL DEFAULT 1,
  origin_id      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_bills_customer ON bills(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_bills_date     ON bills(posting_date);
CREATE INDEX idx_bills_status   ON bills(docstatus);

CREATE TABLE bill_items (
  id              TEXT PRIMARY KEY,
  bill_id         TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  product_id      TEXT NOT NULL REFERENCES products(id),
  -- Snapshot: editing a product must never rewrite what a past bill said.
  product_name    TEXT NOT NULL,
  hsn_code        TEXT,
  sale_unit       TEXT NOT NULL,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  base_qty        INTEGER NOT NULL CHECK (base_qty > 0),
  rate            INTEGER NOT NULL CHECK (rate >= 0),
  mrp             INTEGER,
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_total      INTEGER NOT NULL CHECK (line_total >= 0),
  taxable_value   INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp     INTEGER NOT NULL DEFAULT 0,
  cgst_amount     INTEGER NOT NULL DEFAULT 0,
  sgst_amount     INTEGER NOT NULL DEFAULT 0,
  igst_amount     INTEGER NOT NULL DEFAULT 0,
  -- Which pricing rule produced `rate`. The cashier will be asked; support must
  -- be able to answer without re-deriving it months later.
  price_source    TEXT NOT NULL,
  price_source_id TEXT,
  returned_qty    INTEGER NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  UNIQUE (bill_id, idx)
) STRICT;

CREATE INDEX idx_bill_items_bill    ON bill_items(bill_id);
CREATE INDEX idx_bill_items_product ON bill_items(product_id);

CREATE TABLE bill_payments (
  id         TEXT PRIMARY KEY,
  bill_id    TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  method     TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'credit', 'loyalty')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  reference  TEXT
) STRICT;

CREATE INDEX idx_bill_payments_bill ON bill_payments(bill_id);

-- ─────────────────────────────  returns  ───────────────────────────────────

CREATE TABLE sales_returns (
  id            TEXT PRIMARY KEY,
  doc_no        TEXT NOT NULL UNIQUE,
  docstatus     INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0, 1, 2)),
  amended_from  TEXT REFERENCES sales_returns(id),
  bill_id       TEXT NOT NULL REFERENCES bills(id),
  posting_date  TEXT NOT NULL,
  refund_total  INTEGER NOT NULL DEFAULT 0,
  tax_reversed  INTEGER NOT NULL DEFAULT 0,
  refund_method TEXT NOT NULL CHECK (refund_method IN ('cash', 'upi', 'card', 'credit')),
  reason        TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  rev           INTEGER NOT NULL DEFAULT 1,
  origin_id     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_sales_returns_bill ON sales_returns(bill_id);

CREATE TABLE sales_return_items (
  id             TEXT PRIMARY KEY,
  return_id      TEXT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  bill_item_id   TEXT NOT NULL REFERENCES bill_items(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  qty            INTEGER NOT NULL CHECK (qty > 0),
  base_qty       INTEGER NOT NULL CHECK (base_qty > 0),
  refund_amount  INTEGER NOT NULL CHECK (refund_amount >= 0),
  taxable_value  INTEGER NOT NULL DEFAULT 0,
  cgst_amount    INTEGER NOT NULL DEFAULT 0,
  sgst_amount    INTEGER NOT NULL DEFAULT 0,
  igst_amount    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_sales_return_items_return ON sales_return_items(return_id);

-- ─────────────────────────────  receipts  ──────────────────────────────────

-- Outstanding is derived from these, never from a mutable balance column.
CREATE TABLE payment_entries (
  id           TEXT PRIMARY KEY,
  doc_no       TEXT NOT NULL UNIQUE,
  docstatus    INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0, 1, 2)),
  amended_from TEXT REFERENCES payment_entries(id),
  party_type   TEXT NOT NULL CHECK (party_type IN ('customer', 'supplier')),
  customer_id  TEXT REFERENCES customers(id),
  supplier_id  TEXT REFERENCES suppliers(id),
  posting_date TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'adjustment')),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  reference    TEXT,
  notes        TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  rev          INTEGER NOT NULL DEFAULT 1,
  origin_id    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (
    (party_type = 'customer' AND customer_id IS NOT NULL AND supplier_id IS NULL) OR
    (party_type = 'supplier' AND supplier_id IS NOT NULL AND customer_id IS NULL)
  )
) STRICT;

CREATE INDEX idx_payment_entries_customer ON payment_entries(customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE payment_allocations (
  id         TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payment_entries(id) ON DELETE CASCADE,
  bill_id    TEXT NOT NULL REFERENCES bills(id),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  UNIQUE (payment_id, bill_id)
) STRICT;

CREATE INDEX idx_payment_allocations_bill ON payment_allocations(bill_id);

-- ─────────────────────────────  stock  ─────────────────────────────────────

CREATE TABLE stock_entries (
  id            TEXT PRIMARY KEY,
  doc_no        TEXT NOT NULL UNIQUE,
  docstatus     INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0, 1, 2)),
  amended_from  TEXT REFERENCES stock_entries(id),
  entry_type    TEXT NOT NULL CHECK (entry_type IN ('purchase', 'adjustment', 'opening', 'wastage')),
  posting_date  TEXT NOT NULL,
  supplier_id   TEXT REFERENCES suppliers(id),
  supplier_name TEXT,
  reference     TEXT,
  notes         TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  rev           INTEGER NOT NULL DEFAULT 1,
  origin_id     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE stock_entry_items (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES stock_entries(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  qty        INTEGER NOT NULL CHECK (qty <> 0),
  unit_cost  INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
) STRICT;

-- Append-only. unit_cost is carried on every movement because without it cost
-- history is destroyed and no valuation method is computable after the fact.
CREATE TABLE stock_ledger (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  posting_date  TEXT NOT NULL,
  qty_change    INTEGER NOT NULL CHECK (qty_change <> 0),
  unit_cost     INTEGER,
  balance_qty   INTEGER NOT NULL,
  voucher_type  TEXT NOT NULL,
  voucher_id    TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_stock_ledger_product ON stock_ledger(product_id, posting_date);
CREATE INDEX idx_stock_ledger_voucher ON stock_ledger(voucher_type, voucher_id);

-- Materialised for O(1) preflight. stock_ledger stays the truth; recomputeStock()
-- rebuilds this and reports drift.
CREATE TABLE product_stock (
  product_id  TEXT PRIMARY KEY REFERENCES products(id),
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
) STRICT;

-- ─────────────────────────────  loyalty  ───────────────────────────────────

-- Each earn carries its own expiry; redemption consumes oldest-unexpired first
-- and records what it consumed, so a reversal undoes exactly what happened.
CREATE TABLE loyalty_entries (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  bill_id      TEXT REFERENCES bills(id),
  points       INTEGER NOT NULL CHECK (points > 0),
  consumed     INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  earned_at    TEXT NOT NULL,
  expires_at   TEXT,
  cancelled_at TEXT,
  created_at   TEXT NOT NULL,
  CHECK (consumed <= points)
) STRICT;

CREATE INDEX idx_loyalty_entries_customer ON loyalty_entries(customer_id, expires_at);

CREATE TABLE loyalty_redemptions (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  bill_id          TEXT NOT NULL REFERENCES bills(id),
  loyalty_entry_id TEXT NOT NULL REFERENCES loyalty_entries(id),
  points           INTEGER NOT NULL CHECK (points > 0),
  reversed_at      TEXT,
  created_at       TEXT NOT NULL
) STRICT;

CREATE INDEX idx_loyalty_redemptions_bill ON loyalty_redemptions(bill_id);

-- ─────────────────────────────  audit  ─────────────────────────────────────

-- Append-only by policy and by trigger. Written inside the caller's transaction,
-- so a rolled-back change leaves no audit row claiming it happened.
CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  entity         TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'submit', 'cancel', 'amend', 'login', 'login_failed')),
  actor_id       TEXT,
  docstatus_from INTEGER,
  docstatus_to   INTEGER,
  diff           TEXT,
  at             TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_at     ON audit_log(at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE activity_log (
  id        TEXT PRIMARY KEY,
  actor_id  TEXT REFERENCES users(id),
  action    TEXT NOT NULL,
  entity    TEXT,
  entity_id TEXT,
  summary   TEXT NOT NULL,
  at        TEXT NOT NULL
) STRICT;

CREATE INDEX idx_activity_at ON activity_log(at);

-- ─────────────────────────────  numbering  ─────────────────────────────────

CREATE TABLE doc_sequences (
  scope      TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ─────────────────────────────  replication outbox  ────────────────────────

-- Unused until sync ships. Present now so adding it later is not a migration
-- against every deployed shop's database.
CREATE TABLE sync_queue (
  id          TEXT PRIMARY KEY,
  entity      TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'dead')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  claimed_at  TEXT
) STRICT;

CREATE UNIQUE INDEX idx_sync_queue_pending ON sync_queue(entity, record_id) WHERE status = 'pending';
