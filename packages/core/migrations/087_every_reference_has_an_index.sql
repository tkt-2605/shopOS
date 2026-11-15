-- Every reference has an index (15 Nov).
--
-- From the schema review of 13 Nov, checked with the sqlite3 shell's own rule
-- (`.lint fkey-indexes`): a foreign key needs an index that leads with its
-- column, or every check of it -- cancelling, deleting a parent, the planner
-- answering "bills of this session" -- reads the whole child table. At 58,000
-- bills that was 75 ms a query for the Z report, the payables list, a supplier's
-- statement and a counter's month.
--
-- Indexes and one trigger only: no column, no row, nothing that crosses a sync.
-- So it is additive -- a till either side of it reads and writes the same rows.

-- 1. The four the scale bench measured, shaped for the queries that use them.
CREATE INDEX idx_bills_register_status_date ON bills(register_id, docstatus, posting_date);
CREATE INDEX idx_bills_session ON bills(session_id);
CREATE INDEX idx_stock_entries_supplier ON stock_entries(supplier_id, docstatus, posting_date);
CREATE INDEX idx_payment_entries_supplier ON payment_entries(supplier_id);

-- 2. Every other reference with no index the planner could use.
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_item_prices_price_list ON item_prices(price_list_id);
CREATE INDEX idx_customers_price_list ON customers(price_list_id);
CREATE INDEX idx_cash_sessions_register ON cash_sessions(register_id);
CREATE INDEX idx_cash_sessions_opened_by ON cash_sessions(opened_by);
CREATE INDEX idx_cash_sessions_closed_by ON cash_sessions(closed_by);
CREATE INDEX idx_cash_movements_created_by ON cash_movements(created_by);
CREATE INDEX idx_bills_created_by ON bills(created_by);
CREATE INDEX idx_bills_cancelled_by ON bills(cancelled_by);
CREATE INDEX idx_bill_items_batch ON bill_items(batch_id);
CREATE INDEX idx_sales_returns_credit_note ON sales_returns(credit_note_id);
CREATE INDEX idx_sales_returns_created_by ON sales_returns(created_by);
CREATE INDEX idx_sales_returns_amended_from ON sales_returns(amended_from);
CREATE INDEX idx_sales_return_items_product ON sales_return_items(product_id);
CREATE INDEX idx_payment_entries_created_by ON payment_entries(created_by);
CREATE INDEX idx_payment_entries_amended_from ON payment_entries(amended_from);
CREATE INDEX idx_stock_entries_created_by ON stock_entries(created_by);
CREATE INDEX idx_stock_entries_amended_from ON stock_entries(amended_from);
CREATE INDEX idx_stock_entry_items_product ON stock_entry_items(product_id);
CREATE INDEX idx_stock_ledger_created_by ON stock_ledger(created_by);
CREATE INDEX idx_loyalty_redemptions_customer ON loyalty_redemptions(customer_id);
CREATE INDEX idx_attachments_created_by ON attachments(created_by);
CREATE INDEX idx_stock_counts_created_by ON stock_counts(created_by);
CREATE INDEX idx_stock_counts_entry ON stock_counts(entry_id);
CREATE INDEX idx_stock_counts_category ON stock_counts(category_id);
CREATE INDEX idx_stock_count_items_product ON stock_count_items(product_id);
CREATE INDEX idx_customer_item_prices_product ON customer_item_prices(product_id);
CREATE INDEX idx_documents_amended_from ON documents(amended_from);
CREATE INDEX idx_documents_created_by ON documents(created_by);
CREATE INDEX idx_documents_cancelled_by ON documents(cancelled_by);
CREATE INDEX idx_documents_register ON documents(register_id);
CREATE INDEX idx_document_items_product ON document_items(product_id);
CREATE INDEX idx_batch_movements_created_by ON batch_movements(created_by);
CREATE INDEX idx_stock_entry_batches_batch ON stock_entry_batches(batch_id);
CREATE INDEX idx_web_accounts_customer ON web_accounts(customer_id);
CREATE INDEX idx_web_accounts_phone_verified_by ON web_accounts(phone_verified_by);
CREATE INDEX idx_web_orders_proposed_by ON web_orders(proposed_by);
CREATE INDEX idx_web_orders_answered_by ON web_orders(answered_by);
CREATE INDEX idx_product_photos_thumb ON product_photos(thumb_id);
CREATE INDEX idx_product_photos_photo ON product_photos(photo_id);

-- 3. References whose only index was partial. `WHERE x IS NOT NULL` serves the
--    planner, but the shell's lint does not count it, and idx_products_parent
--    also left out deleted items, so the planner could not use it for the key
--    either. Same names, whole tables; the null rows cost a few bytes each.
DROP INDEX idx_bills_customer;
CREATE INDEX idx_bills_customer ON bills(customer_id);
DROP INDEX idx_bills_converted;
CREATE INDEX idx_bills_converted ON bills(converted_from);
DROP INDEX idx_bills_amended_from;
CREATE INDEX idx_bills_amended_from ON bills(amended_from);
DROP INDEX idx_payment_entries_customer;
CREATE INDEX idx_payment_entries_customer ON payment_entries(customer_id);
DROP INDEX idx_documents_customer;
CREATE INDEX idx_documents_customer ON documents(customer_id);
DROP INDEX idx_documents_supplier;
CREATE INDEX idx_documents_supplier ON documents(supplier_id);
DROP INDEX idx_documents_converted;
CREATE INDEX idx_documents_converted ON documents(converted_from);
DROP INDEX idx_loyalty_entries_bill;
CREATE INDEX idx_loyalty_entries_bill ON loyalty_entries(bill_id);
DROP INDEX idx_web_orders_document;
CREATE INDEX idx_web_orders_document ON web_orders(document_id);
DROP INDEX idx_products_parent;
CREATE INDEX idx_products_parent ON products(parent_product_id);

-- 4. Five indexes a UNIQUE constraint already covers: each is a leading prefix
--    of the constraint's own index, so the planner never needed them and every
--    write paid for them twice.
DROP INDEX idx_bill_items_bill;              -- UNIQUE (bill_id, idx)
DROP INDEX idx_document_items_doc;           -- UNIQUE (document_id, idx)
DROP INDEX idx_stock_count_items_count;      -- UNIQUE (count_id, product_id)
DROP INDEX idx_item_prices_lookup;           -- UNIQUE (product_id, price_list_id, sale_unit, min_qty)
DROP INDEX idx_customer_item_prices_lookup;  -- UNIQUE (customer_id, product_id, sale_unit, min_qty)

-- 5. A posting names a voucher kind the books know. The column is free text and
--    every report joins on it, so a misspelt kind would post balanced lines
--    that no report ever finds. Only this till's own postings are held to it:
--    a row arriving by sync is a fact already written elsewhere, perhaps by a
--    newer till that knows a kind this one does not, and refusing it would
--    stall the merge (the same reason every change_feed trigger skips them).
CREATE TRIGGER gl_entries_voucher_type_is_known BEFORE INSERT ON gl_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
  AND NEW.voucher_type NOT IN ('bill', 'sales_return', 'payment', 'stock_entry', 'cash_session', 'cash_payout', 'supplier_opening')
BEGIN
  SELECT RAISE(ABORT, 'gl_entries.voucher_type is not a kind of voucher the books know');
END;
