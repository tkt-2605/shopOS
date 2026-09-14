-- A bill that came from an order, and what it marked off.
--
-- This is the last link in the chain the documents were built for: a quotation
-- becomes a sales order becomes a bill. The three earlier steps already record
-- what they came from; a bill did not, because until now nothing could turn one
-- into a bill at all.
--
-- The moment that matters is **payment**, not loading the cart. A cashier who
-- pulls an order onto the counter and is then interrupted has delivered
-- nothing, and an order marked off by an abandoned cart is an order the shop
-- believes it has already sent out. So `converted_from` rides on the draft from
-- the moment it is loaded — it survives the power going out the way every other
-- part of a draft does — and nothing is marked off until the bill is submitted.
ALTER TABLE bills ADD COLUMN converted_from TEXT REFERENCES documents(id);

CREATE INDEX idx_bills_converted ON bills(converted_from) WHERE converted_from IS NOT NULL;

-- What each bill took off which order line.
--
-- `document_items.fulfilled_qty` is the running total, and this is the working
-- that produced it. It exists because cancelling a bill has to give back
-- exactly what that bill took, and recomputing the share afterwards is not the
-- same question: by then another bill may have consumed the rest of the line,
-- and a recomputed reversal would hand back a number that was never taken.
--
-- One bill line can span two order lines for the same item — six billed against
-- an order that lists five and one — so this is a table rather than a pair of
-- columns on `bill_items`.
--
-- Rows are deleted when the bill that made them is cancelled, which keeps
-- `fulfilled_qty` equal to the sum of what stands. What happened is in the
-- audit log, which is where the history of a reversal belongs.
CREATE TABLE bill_fulfilments (
  id               TEXT PRIMARY KEY,
  bill_id          TEXT NOT NULL REFERENCES bills(id),
  document_id      TEXT NOT NULL REFERENCES documents(id),
  document_item_id TEXT NOT NULL REFERENCES document_items(id),
  -- In the order line's own sale unit, the same scale `fulfilled_qty` counts in,
  -- so a bill in pieces against an order in dozens marks off dozens.
  qty              INTEGER NOT NULL CHECK (qty > 0),
  created_at       TEXT NOT NULL
) STRICT;

CREATE INDEX idx_bill_fulfilments_bill ON bill_fulfilments(bill_id);
CREATE INDEX idx_bill_fulfilments_document ON bill_fulfilments(document_id);
