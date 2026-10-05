-- The general ledger.
--
-- Every figure this product kept was a ledger of one thing: the stock ledger,
-- the drawer's movements, the khata, the points. Each was right on its own and
-- nothing put them together, so the questions a shop's accounts answer -- what
-- did we make this month, what do we own and owe -- had no answer anywhere,
-- and nothing showed that the separate ledgers agreed with one another.
--
-- `gl_entries` is double entry: every submitted document posts lines whose
-- debits equal their credits, in the same transaction as the document, and a
-- cancellation posts the mirror of them rather than removing anything. The
-- accounts are named in code (`domain/ledger.ts`), not in a table, so there is
-- no chart for two tills to disagree about.
--
-- Append-only, like `stock_ledger` and `batch_movements`, and it travels the
-- same way they do: a row is inserted once and never changes. The ids are
-- derived from the document -- `bill:<id>:0`, `bill:<id>:r0` for its reversal --
-- so a till that works out the entries for a document another till also
-- posted writes the same rows rather than a second set. That is also why the
-- guard below lets an update through when nothing an accountant reads has
-- changed: the same row arriving twice is not an edit.
--
-- Additive: one new table, its indexes and triggers. A till below this skips
-- the rows as a table it does not have; when it is updated it works out the
-- entries for whatever it holds (`postMissingGl`).

CREATE TABLE gl_entries (
  id            TEXT PRIMARY KEY,
  posting_date  TEXT NOT NULL CHECK (posting_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  account       TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 40),
  party_type    TEXT CHECK (party_type IS NULL OR party_type IN ('customer', 'supplier')),
  party_id      TEXT,
  debit         INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit        INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  voucher_type  TEXT NOT NULL,
  voucher_id    TEXT NOT NULL,
  is_reversal   INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0, 1)),
  created_at    TEXT NOT NULL,
  -- One side or the other, never both and never neither.
  CHECK ((debit = 0) <> (credit = 0)),
  -- A party needs its kind. A kind may stand alone: goods bought from nobody named.
  CHECK (party_id IS NULL OR party_type IS NOT NULL)
) STRICT;

CREATE INDEX idx_gl_entries_account_date ON gl_entries(account, posting_date);
CREATE INDEX idx_gl_entries_voucher ON gl_entries(voucher_type, voucher_id);
CREATE INDEX idx_gl_entries_party ON gl_entries(party_type, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX idx_gl_entries_date ON gl_entries(posting_date);

CREATE TRIGGER gl_entries_is_append_only_upd BEFORE UPDATE ON gl_entries FOR EACH ROW
WHEN NEW.account IS NOT OLD.account OR NEW.debit IS NOT OLD.debit OR NEW.credit IS NOT OLD.credit
  OR NEW.posting_date IS NOT OLD.posting_date OR NEW.party_type IS NOT OLD.party_type
  OR NEW.party_id IS NOT OLD.party_id OR NEW.voucher_type IS NOT OLD.voucher_type
  OR NEW.voucher_id IS NOT OLD.voucher_id OR NEW.is_reversal IS NOT OLD.is_reversal
BEGIN
  SELECT RAISE(ABORT, 'gl_entries is append-only: post a reversing entry instead');
END;

CREATE TRIGGER gl_entries_is_append_only_del BEFORE DELETE ON gl_entries FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'gl_entries is append-only: post a reversing entry instead');
END;

CREATE TRIGGER feed_gl_entries_ins AFTER INSERT ON gl_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'gl_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('gl_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_gl_entries_upd AFTER UPDATE ON gl_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'gl_entries' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('gl_entries', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_gl_entries_del AFTER DELETE ON gl_entries FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'gl_entries' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('gl_entries', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
