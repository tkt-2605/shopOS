-- A main that hands its place on keeps answering until the new main has heard.
--
-- `handTheMainTo` makes another till the main from this one. The other till
-- learns it the next time it catches up with this one -- and it can only do
-- that by dialling this one, because until it learns it believes it is a till,
-- and a till does not answer. This one, now a till itself, stopped answering
-- at once in a shop paired before there was a main, where every till holds
-- every other's address (`listens`): each believed the other was the main,
-- neither answered, and the shop stopped syncing. Found at a shop on 21 October.
--
-- `handed_over_at` is when this till handed over. Until the new main has
-- caught up with it since then, this till goes on answering, whatever its
-- peers' addresses say. Null on every till that never handed over.
--
-- Additive: a column on a table that stays on this machine.

ALTER TABLE sync_state ADD COLUMN handed_over_at TEXT;
