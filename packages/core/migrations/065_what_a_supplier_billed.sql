-- A purchase as the supplier's bill: its number and date, the tax on it, and
-- what the shop owes for it.
--
-- A delivery was a stock entry with a cost per line and nothing else. The
-- supplier's invoice number and date lived in a free-text `reference`, the GST
-- on it was nowhere -- so the input tax a registered shop can claim against its
-- own output tax could not be added up -- and what the shop owed was a figure
-- typed onto the supplier by hand (050) that no delivery or payment moved.
--
-- So a purchase entry now carries:
--
-- - `supplier_invoice_no` and `supplier_invoice_date`, as printed on their bill;
-- - per line, the GST and cess rates and amounts on the line's cost, which stays
--   before tax (`unit_cost`) -- the input tax is claimed, not stocked;
-- - `round_off`, for a supplier's bill rounded to the rupee, and
--   `invoice_total`, what the bill comes to and what is owed for it;
-- - `input_tax_claimed`: whether the tax went to the shop's input credit (a
--   registered shop) or into the cost of the goods (composition and
--   unregistered shops, which may not claim it). Decided when the entry is
--   posted and kept, so a shop that changes scheme does not rewrite last
--   year's stock values.
--
-- Backfilled: a purchase already posted owes what its lines cost, with no tax
-- recorded, which is what it always said. The guard on a posted entry (059) is
-- then rebuilt to hold the new columns too, after the backfill, which it would
-- otherwise refuse.
--
-- Breaking. A purchase's tax and total, relayed through a till that has not
-- got these columns, would arrive as no tax and owing nothing.

ALTER TABLE stock_entries ADD COLUMN supplier_invoice_no TEXT
  CHECK (supplier_invoice_no IS NULL OR length(supplier_invoice_no) BETWEEN 1 AND 40);
ALTER TABLE stock_entries ADD COLUMN supplier_invoice_date TEXT
  CHECK (supplier_invoice_date IS NULL
    OR supplier_invoice_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE stock_entries ADD COLUMN round_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_entries ADD COLUMN invoice_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_entries ADD COLUMN input_tax_claimed INTEGER NOT NULL DEFAULT 1
  CHECK (input_tax_claimed IN (0, 1));

ALTER TABLE stock_entry_items ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0);
ALTER TABLE stock_entry_items ADD COLUMN cess_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (cess_rate_bp >= 0);
ALTER TABLE stock_entry_items ADD COLUMN cgst_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_entry_items ADD COLUMN sgst_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_entry_items ADD COLUMN igst_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_entry_items ADD COLUMN cess_amount INTEGER NOT NULL DEFAULT 0;

UPDATE sync_state SET applying = 1 WHERE id = 1;
UPDATE stock_entries
   SET invoice_total = (
     SELECT COALESCE(SUM(CAST(ROUND(i.qty * i.unit_cost / 10000.0) AS INTEGER)), 0)
       FROM stock_entry_items i WHERE i.entry_id = stock_entries.id)
 WHERE entry_type = 'purchase';
UPDATE sync_state SET applying = 0 WHERE id = 1;

DROP TRIGGER stock_entries_submitted_is_final;
CREATE TRIGGER stock_entries_submitted_is_final BEFORE UPDATE ON stock_entries FOR EACH ROW
WHEN OLD.docstatus > 0 AND (
  NEW.docstatus < OLD.docstatus
  OR NEW.doc_no IS NOT OLD.doc_no
  OR NEW.posting_date IS NOT OLD.posting_date
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.amended_from IS NOT OLD.amended_from
  OR NEW.round_off IS NOT OLD.round_off
  OR NEW.invoice_total IS NOT OLD.invoice_total
  OR NEW.supplier_invoice_no IS NOT OLD.supplier_invoice_no
  OR NEW.supplier_invoice_date IS NOT OLD.supplier_invoice_date
  OR NEW.input_tax_claimed IS NOT OLD.input_tax_claimed
)
BEGIN
  SELECT RAISE(ABORT, 'stock_entries: a submitted document is final; cancel it and raise a new one');
END;
