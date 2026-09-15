-- Bill numbers that fit inside the law, without restarting the series.
--
-- Rule 46(b) caps an invoice serial at 16 characters, and Rule 53 says the same
-- for a credit or debit note. `INV/MR/26-27/00001` is eighteen, and twenty-two
-- with the six-character prefix `createRegister` used to allow. Every document
-- raised before today was over, and it would have been refused outright by
-- e-invoicing the day a shop crossed the turnover threshold.
--
-- The new shape is `BMR/2627/00001`: one letter for the kind of document, the
-- register prefix, the fiscal year without its hyphen, and five digits. Fourteen
-- characters on a two-letter prefix and exactly sixteen on the four-letter
-- maximum the prefix rule now enforces.
--
-- ── Why this migration exists at all ──────────────────────────────────────
--
-- The fiscal year is part of the `doc_sequences` scope key, and it has changed
-- shape: `bill:MR:26-27` is now `bill:MR:2627`. Left alone, the new key would
-- not exist, the counter would start from zero, and the next bill after
-- `INV/MR/26-27/00029` would be `BMR/2627/00001`.
--
-- That is not a cosmetic problem. A GST series has to be consecutive, and a shop
-- cannot explain to an assessing officer why its twenty-ninth bill was followed
-- by its first. So each old scope is carried over to its new name with the count
-- it had reached, and the next bill is `BMR/2627/00030`.
--
-- Documents already raised keep the numbers they were printed with. A submitted
-- document is never rewritten -- that is this schema's oldest rule and it is
-- also the legal one. The old numbers stay on the old bills, which are the ones
-- in the customer's hand.
--
-- ── What this does not fix ────────────────────────────────────────────────
--
-- A register created before today with a prefix longer than four characters
-- still produces numbers over sixteen, and its prefix cannot be changed once a
-- bill carries it. `docNoFits` in numbering.ts exists so a screen can say so.
-- Nothing here can repair it; a shop in that position needs a new register.

INSERT INTO doc_sequences (scope, last_value)
SELECT
  -- Keep everything up to and including the last colon, then the year without
  -- its hyphen: `bill:MR:26-27` becomes `bill:MR:2627`. Dropping the colon here
  -- silently produced `bill:MR2627`, a key nothing reads, which would have let
  -- the counter start from zero after all.
  substr(scope, 1, length(scope) - 5) || replace(substr(scope, -5), '-', ''),
  last_value
FROM doc_sequences
-- Only the old shape: a scope ending in `:YY-YY`.
WHERE substr(scope, -6, 1) = ':'
  AND substr(scope, -3, 1) = '-'
ON CONFLICT (scope) DO UPDATE SET
  -- A till that has already billed under the new shape keeps whichever count is
  -- further on, so carrying over can never hand back a number already used.
  last_value = max(doc_sequences.last_value, excluded.last_value);
