-- An online customer the shop can stop, and sign out.
--
-- A storefront session is signed, not stored (`services/web/session.ts`), so
-- until now the only way to end one early was a new key, which signs out every
-- customer at once. Two columns on the account end one person's:
--
--   blocked_at         set: the account can neither sign in nor place, see or
--                      cancel an order. Cleared to let them back.
--   signed_out_before  every session issued before this moment is refused --
--                      a phone lost, or a session the customer wants ended.
--
-- Additive: two nullable columns, written only by the main and read only by
-- the main when it answers the storefront. A till below 083 relays an account
-- without them.

ALTER TABLE web_accounts ADD COLUMN blocked_at TEXT;
ALTER TABLE web_accounts ADD COLUMN signed_out_before TEXT;
