-- Which document a quotation, sales order or purchase order corrects.
--
-- An issued document is never changed: it is something the shop has said. A
-- correction cancels it and issues a new one with the change in it
-- (`services/documents/amend.ts`), as a bill is corrected, and the new one
-- names the one it replaced -- so the screen can say "corrects SQ-0012" and the
-- cancelled one "corrected by SQ-0013". Bills, returns, payments and stock
-- entries have carried `amended_from` since 001; documents came later (016)
-- without it.
--
-- No backfill: nothing issued before this was ever corrected this way.
--
-- Additive: a nullable column, read only to show the link. A document made on a
-- till below 086 arrives without it and reads as null, which is what it is.

ALTER TABLE documents ADD COLUMN amended_from TEXT REFERENCES documents(id);

-- And once issued, which one it corrects is as final as its number: the guard
-- from 059 is made again with the new column in it.

DROP TRIGGER documents_submitted_is_final;
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
  OR NEW.amended_from IS NOT OLD.amended_from
)
BEGIN
  SELECT RAISE(ABORT, 'documents: a submitted document is final; cancel it and raise a new one');
END;
