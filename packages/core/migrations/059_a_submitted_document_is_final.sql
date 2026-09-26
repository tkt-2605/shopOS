-- A submitted document, held by the database as well as by the code.
--
-- `refusedAsSubmitted` in integrity/docstatus.ts keeps a merge from rewriting a
-- submitted or cancelled document, and the services refuse to edit one. Nothing
-- underneath held it: a future service, a repair script or a hand edit could
-- move a document back to draft or change its total, and the change feed would
-- carry it to every till. The schema review found the ledger in the same state;
-- 052 closed that one.
--
-- So each document table refuses, once a row is submitted:
--
-- - its docstatus going backwards -- cancelled to submitted, submitted to draft;
-- - any of the frozen columns changing -- `FROZEN` in docstatus.ts, the same
--   list the merge enforces, restricted to the columns each table has.
--   `docstatus.test.ts` holds the two lists in step.
--
-- What a submitted document may still do is untouched: be cancelled, be paid
-- against (`paid_total`), be closed (a drawer's counting columns), and carry
-- the merge's own bookkeeping.
--
-- Additive: triggers only.

CREATE TRIGGER bills_submitted_is_final BEFORE UPDATE ON bills FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.doc_no IS NOT OLD.doc_no
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.amended_from IS NOT OLD.amended_from
  OR NEW.register_id IS NOT OLD.register_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.subtotal IS NOT OLD.subtotal
  OR NEW.discount IS NOT OLD.discount
  OR NEW.taxable_total IS NOT OLD.taxable_total
  OR NEW.tax_total IS NOT OLD.tax_total
  OR NEW.round_off IS NOT OLD.round_off
  OR NEW.grand_total IS NOT OLD.grand_total
  OR NEW.credit_total IS NOT OLD.credit_total
  OR NEW.place_of_supply IS NOT OLD.place_of_supply
  OR NEW.supply_type IS NOT OLD.supply_type
  OR NEW.customer_gstin IS NOT OLD.customer_gstin
  OR NEW.customer_state_code IS NOT OLD.customer_state_code
  OR NEW.customer_address IS NOT OLD.customer_address
)
BEGIN
  SELECT RAISE(ABORT, 'bills: a submitted document is final; cancel it and raise a new one');
END;

CREATE TRIGGER sales_returns_submitted_is_final BEFORE UPDATE ON sales_returns FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.doc_no IS NOT OLD.doc_no
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.amended_from IS NOT OLD.amended_from
  OR NEW.bill_id IS NOT OLD.bill_id
  OR NEW.refund_total IS NOT OLD.refund_total
  OR NEW.tax_reversed IS NOT OLD.tax_reversed
)
BEGIN
  SELECT RAISE(ABORT, 'sales_returns: a submitted document is final; cancel it and raise a new one');
END;

CREATE TRIGGER payment_entries_submitted_is_final BEFORE UPDATE ON payment_entries FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.doc_no IS NOT OLD.doc_no
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.amended_from IS NOT OLD.amended_from
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.amount IS NOT OLD.amount
)
BEGIN
  SELECT RAISE(ABORT, 'payment_entries: a submitted document is final; cancel it and raise a new one');
END;

CREATE TRIGGER stock_entries_submitted_is_final BEFORE UPDATE ON stock_entries FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.doc_no IS NOT OLD.doc_no
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.amended_from IS NOT OLD.amended_from
)
BEGIN
  SELECT RAISE(ABORT, 'stock_entries: a submitted document is final; cancel it and raise a new one');
END;

CREATE TRIGGER stock_counts_submitted_is_final BEFORE UPDATE ON stock_counts FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.doc_no IS NOT OLD.doc_no
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.created_by IS NOT OLD.created_by
)
BEGIN
  SELECT RAISE(ABORT, 'stock_counts: a submitted document is final; cancel it and raise a new one');
END;

CREATE TRIGGER documents_submitted_is_final BEFORE UPDATE ON documents FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.doc_no IS NOT OLD.doc_no
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.register_id IS NOT OLD.register_id
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.subtotal IS NOT OLD.subtotal
  OR NEW.discount IS NOT OLD.discount
  OR NEW.taxable_total IS NOT OLD.taxable_total
  OR NEW.tax_total IS NOT OLD.tax_total
  OR NEW.round_off IS NOT OLD.round_off
  OR NEW.grand_total IS NOT OLD.grand_total
  OR NEW.place_of_supply IS NOT OLD.place_of_supply
)
BEGIN
  SELECT RAISE(ABORT, 'documents: a submitted document is final; cancel it and raise a new one');
END;

CREATE TRIGGER cash_sessions_submitted_is_final BEFORE UPDATE ON cash_sessions FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.register_id IS NOT OLD.register_id
)
BEGIN
  SELECT RAISE(ABORT, 'cash_sessions: a submitted document is final; cancel it and raise a new one');
END;
