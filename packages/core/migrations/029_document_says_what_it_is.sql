-- The roll that never said what it was.
--
-- Migration 014 shipped the standard receipt with its title block switched off,
-- for a good reason at the time: the format had to reproduce what `buildReceipt`
-- printed before formats existed, byte for byte, so that no shop saw its paper
-- change on an upgrade it did not ask for.
--
-- Rule 46(b) is the other side of that. A tax invoice has to say that it is one,
-- and for a counter sale this roll *is* the tax invoice -- there is no sheet
-- behind it. The document has been going out headed with the shop's name and
-- nothing else.
--
-- It matters most for the shops that are not on the regular scheme, which Phase
-- 1b gives this product its first way of saying. A composition dealer's paper
-- must read "Bill of Supply" and carry the Rule 49 statement, and an
-- unregistered shop's must not read "Tax Invoice". A document that says nothing
-- about itself is read as a tax invoice by whoever is holding it, which is
-- exactly what those two must not be.
--
-- ── Why this reaches into a format a shop may have edited ─────────────────
--
-- Only the shipped row, by id. A format the shop created, or a copy it made, is
-- its own and is left alone.
--
-- A shop that deliberately turned this switch off on the shipped format gets it
-- back, which is a real cost and is accepted: the title is not decoration, and
-- a switch that lets a shop print an untitled tax invoice is a switch that
-- should not have existed. The label itself is untouched, and the bill's own
-- wording outranks it -- that is what carries the scheme onto the paper.

-- ── Why this is more than one UPDATE ───────────────────────────────
--
-- Every till in a shop runs this migration and arrives at exactly the same row,
-- so they still agree and there is nothing to sync. Two triggers disagree.
--
-- `feed_doc_formats_upd` (021) would push this row into the change feed as a
-- local edit, and `bump_rev_doc_formats` (022) would raise its `rev` -- on each
-- till separately, at whatever moment each one happened to upgrade. The next
-- sync would then find both sides claiming to have changed a row neither person
-- touched, report a conflict on the shop's receipt format, and drop one side's
-- "edit". A conflict manufactured entirely by the upgrade. `sync.test.ts`
-- catches exactly this, which is how it was found.
--
-- So: `applying = 1` around the write, which is the same flag sync itself sets
-- when it applies somebody else's rows and means precisely what is meant here --
-- this is not a local edit. And `rev` is put back afterwards, which the bump
-- trigger ignores because it only fires `WHEN NEW.rev = OLD.rev`.
--
-- `updated_at` is left alone for the same reason, and 028's `rev` was left alone
-- for this reason before it had a name.

UPDATE sync_state SET applying = 1 WHERE id = 1;

UPDATE doc_formats
   SET blocks = replace(
         blocks,
         '{"kind":"title","on":false,"opts":{"label":"TAX INVOICE"}}',
         '{"kind":"title","on":true,"opts":{"label":"TAX INVOICE"}}'
       )
 WHERE id = 'standard_receipt';

-- Back to whatever it was, including for a shop that has edited this format
-- before. The decrement is not seen by the bump trigger.
UPDATE doc_formats SET rev = rev - 1 WHERE id = 'standard_receipt';

UPDATE sync_state SET applying = 0 WHERE id = 1;
