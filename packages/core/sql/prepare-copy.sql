-- What a copy of the shop leaves behind before it travels to a joining till.
--
-- Run on a `VACUUM INTO` copy of the main's database, never on the main itself.
-- The copy is the shop -- every replicated table as the main holds it -- and
-- nothing that is only true of the machine it was taken on. Those are the
-- tables `NOT_REPLICATED` names (`domain/replicaShape.ts`), and
-- `copyOfTheShop.test.ts` fails if one is added there and not handled here.
--
-- The joining till brings its own of each when the copy is installed
-- (`carry-over-after-copy.sql`), so emptying them here is also what keeps the
-- main's pairing secrets off the wire.
--
-- Two are not emptied:
--   product_stock  derived from stock_ledger, and the copy's matches the
--                  copy's ledger exactly; recomputing it would give the same.
--   audit_log      append-only, guarded by a trigger against deletion. It
--                  travels: the main's own history of the shop, which the
--                  joining till's owner already owns. Its own rows are added
--                  back alongside on install.
--
-- Read by `apps/pos/src-tauri/src/shop_copy.rs` with `include_str!` and by the
-- tests from disk, so the statements a test proves are the ones the app runs.

DELETE FROM sync_peers;
DELETE FROM change_feed;
DELETE FROM sync_conflicts;
DELETE FROM sync_quarantine;
DELETE FROM discrepancies_seen;
DELETE FROM bill_emails;
DELETE FROM doc_sequences;
-- The key the main signs customers' web sessions with, which never leaves it.
DELETE FROM web_state;
UPDATE sync_state
   SET applying = 0, pruned_through = 0, main_device = NULL, main_epoch = 0
 WHERE id = 1;
