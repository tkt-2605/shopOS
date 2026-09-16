-- A receipt can only ever have meant money coming in.
--
-- `payment_entries` has `amount INTEGER CHECK (amount > 0)` and nothing to say
-- which way it went, because until now every one of them went the same way: a
-- customer paying down their khata, or a credit note raised when goods came
-- back. Both are money the shop keeps.
--
-- ── what could not be recorded ────────────────────────────────────────────
--
-- A customer owed 710 and handed over 1,200. The extra 490 is already in the
-- database -- it is the part of the receipt that no allocation points at -- and
-- it is money the shop is holding on their behalf. There are exactly two things
-- a shop does with it: keep it against the next bill, or hand it back.
--
-- Keeping it needs nothing new. An allocation from that receipt to the next
-- bill is what "redeemed" means, and `payment_allocations` has always been able
-- to express it.
--
-- Handing it back could not be written down at all. The money leaves the
-- drawer, and every row in this table asserts the opposite. The only ways to
-- record it without this column were to cancel the receipt and re-enter it
-- smaller -- rewriting a submitted document, which this codebase does not do --
-- or to leave the shop's books saying it still holds money it has given away.
--
-- ── why a column and not a separate table ─────────────────────────────────
--
-- A refund of an advance is a receipt in every respect except its sign: it has
-- a document number in the same series, a method, a date, a person who made it,
-- and it belongs in the customer's statement between the others. A second table
-- would duplicate all of that and then need a second set of rules to keep the
-- two in step.
--
-- ── 'in' for everything already here, which is what it means ──────────────
--
-- Every existing row is money the shop took. The default backfills them
-- correctly by saying what was already true, so there is nothing to migrate --
-- and a till that has not been upgraded cannot produce an 'out' row, so a shop
-- mid-upgrade reads the new column as 'in' and is right.
--
-- The CHECK is deliberately two values rather than a free string. A third
-- direction is not a thing that exists, and a typo that wrote one would be a
-- receipt that counts as neither.

ALTER TABLE payment_entries
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'
  CHECK (direction IN ('in', 'out'));

-- Finding a customer's advance means reading their receipts, and finding the
-- refunds against it means reading them again. Partial, because 'out' rows are
-- a small minority of a table that is mostly ordinary receipts -- so the index
-- stays small and every write of an ordinary receipt skips it entirely.
CREATE INDEX idx_payment_entries_refunds
  ON payment_entries (customer_id, posting_date)
  WHERE direction = 'out' AND customer_id IS NOT NULL;
